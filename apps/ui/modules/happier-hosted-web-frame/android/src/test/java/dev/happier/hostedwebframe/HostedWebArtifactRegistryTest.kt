package dev.happier.hostedwebframe

import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.io.path.writeBytes
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostedWebArtifactRegistryTest {
  @Test
  fun `splits Protocol HTTP content types into Android MIME and nullable charset facts`() {
    assertEquals(
      WebResourceResponseContentType("text/javascript", "utf-8"),
      parseWebResourceResponseContentType("text/javascript; charset=utf-8")
    )
    assertEquals(
      WebResourceResponseContentType("text/css", "UTF-8"),
      parseWebResourceResponseContentType("text/css; Charset=\"UTF-8\"")
    )
    assertEquals(
      WebResourceResponseContentType("image/png", null),
      parseWebResourceResponseContentType("image/png")
    )
    assertEquals(
      WebResourceResponseContentType("font/woff2", null),
      parseWebResourceResponseContentType("font/woff2; boundary=unused")
    )
    assertNull(parseWebResourceResponseContentType("; charset=utf-8"))
  }

  @Test
  fun `reserves the hosted apex and every non-active hosted subdomain`() {
    assertFalse(HostedWebArtifactView.isReservedHostedWebDomain(
      "hpa_active.plugins.happier.dev",
      isActiveOrigin = true
    ))
    assertTrue(HostedWebArtifactView.isReservedHostedWebDomain(
      "plugins.happier.dev",
      isActiveOrigin = false
    ))
    assertTrue(HostedWebArtifactView.isReservedHostedWebDomain(
      "plugins.happier.dev.",
      isActiveOrigin = false
    ))
    assertTrue(HostedWebArtifactView.isReservedHostedWebDomain(
      "hpa_sibling.plugins.happier.dev",
      isActiveOrigin = false
    ))
    assertTrue(HostedWebArtifactView.isReservedHostedWebDomain(
      "hpa_sibling.plugins.happier.dev.",
      isActiveOrigin = false
    ))
    assertTrue(HostedWebArtifactView.isReservedHostedWebDomain(
      "hpa_active.plugins.happier.dev",
      isActiveOrigin = false
    ))
    assertFalse(HostedWebArtifactView.isReservedHostedWebDomain(
      "declared.example.test",
      isActiveOrigin = false
    ))
    assertFalse(HostedWebArtifactView.isReservedHostedWebDomain(
      "plugins.happier.dev..",
      isActiveOrigin = false
    ))
  }

  @Test
  fun `tombstoning a token makes a later artifact request reject synchronously`() {
    val cacheRoot = Files.createTempDirectory("hosted-web-frame-test")
    try {
      val registry = HostedWebArtifactRegistry(cacheRoot.toFile())
      val token = "hpat_test_token"
      writeResource(cacheRoot, scriptStoredFileName, "console.log('frame')".toByteArray())

      assertTrue(registry.register(registration(token)))
      assertEquals(200, registry.resolve(token, "/assets/app.js").status)

      assertTrue(registry.unregister(token))
      assertEquals(404, registry.resolve(token, "/assets/app.js").status)
    } finally {
      cacheRoot.toFile().deleteRecursively()
    }
  }

  @Test
  fun `rejects a same-size resource mutation after registration`() {
    val cacheRoot = Files.createTempDirectory("hosted-web-frame-test")
    try {
      val registry = HostedWebArtifactRegistry(cacheRoot.toFile())
      val token = "hpat_digest_mutation_token"
      val originalBytes = scriptBytes
      val mutatedBytes = originalBytes.map { byte -> (byte.toInt() xor 1).toByte() }.toByteArray()
      assertEquals(originalBytes.size, mutatedBytes.size)
      assertFalse(originalBytes.contentEquals(mutatedBytes))
      writeResource(cacheRoot, scriptStoredFileName, originalBytes)

      assertTrue(registry.register(registration(token)))
      assertEquals(200, registry.resolve(token, "/assets/app.js").status)
      writeResource(cacheRoot, scriptStoredFileName, mutatedBytes)

      assertEquals(404, registry.resolve(token, "/assets/app.js").status)
    } finally {
      cacheRoot.toFile().deleteRecursively()
    }
  }

  @Test
  fun `interprets exact native-policy responses and never invents a resource fallback`() {
    val cacheRoot = Files.createTempDirectory("hosted-web-frame-test")
    try {
      val registry = HostedWebArtifactRegistry(cacheRoot.toFile())
      val token = "hpat_policy_token"
      writeResource(cacheRoot, scriptStoredFileName, "console.log('frame')".toByteArray())
      writeResource(cacheRoot, entryStoredFileName, "<main>entry</main>".toByteArray())

      assertTrue(registry.register(registration(token, includeFallback = true)))

      val exact = registry.resolve(token, "/assets/app.js?cache=bust")
      assertEquals(200, exact.status)
      assertEquals("r0", exact.resourceId)
      assertEquals("text/javascript; charset=utf-8", exact.contentType)
      assertEquals("nosniff", exact.headers["X-Content-Type-Options"])
      assertFalse(exact.fallback)

      val fallback = registry.resolve(token, "/settings/team")
      assertEquals(200, fallback.status)
      assertEquals("r1", fallback.resourceId)
      assertTrue(fallback.fallback)

      assertEquals(400, registry.resolve(token, "/%2e%2e/outside.js").status)
      assertEquals(415, registry.resolve(token, "/assets/blob.bin").status)
      assertEquals(404, registry.resolve(token, "/assets/not-declared.js").status)
      assertEquals(404, registry.resolve(token, "/directory/").status)
    } finally {
      cacheRoot.toFile().deleteRecursively()
    }
  }

  @Test
  fun `a request that began before revocation may finish but no later request observes the token`() {
    val cacheRoot = Files.createTempDirectory("hosted-web-frame-test")
    val executor = Executors.newFixedThreadPool(2)
    try {
      val registry = HostedWebArtifactRegistry(cacheRoot.toFile())
      val token = "hpat_race_token"
      writeResource(cacheRoot, scriptStoredFileName, "console.log('frame')".toByteArray())
      assertTrue(registry.register(registration(token)))

      val requestEntered = CountDownLatch(1)
      val releaseRequest = CountDownLatch(1)
      val pendingRequest = executor.submit<Int> {
        registry.withResolved(token, "/assets/app.js") { response ->
          requestEntered.countDown()
          assertTrue(releaseRequest.await(5, TimeUnit.SECONDS))
          response.status
        }
      }
      assertTrue(requestEntered.await(5, TimeUnit.SECONDS))

      val pendingRevoke = executor.submit<Boolean> { registry.unregister(token) }
      Thread.sleep(50)
      assertFalse("revocation cannot acknowledge before the active lookup linearizes", pendingRevoke.isDone)

      releaseRequest.countDown()
      assertEquals(200, pendingRequest.get(5, TimeUnit.SECONDS))
      assertTrue(pendingRevoke.get(5, TimeUnit.SECONDS))
      assertEquals(404, registry.resolve(token, "/assets/app.js").status)
    } finally {
      executor.shutdownNow()
      cacheRoot.toFile().deleteRecursively()
    }
  }

  @Test
  fun `invalid native registration cannot leave a partially reachable token`() {
    val cacheRoot = Files.createTempDirectory("hosted-web-frame-test")
    try {
      val registry = HostedWebArtifactRegistry(cacheRoot.toFile())
      val token = "hpat_invalid_token"
      val malformed = registration(token).toMutableMap().apply {
        this["storagePartitionId"] = "not-an-opaque-partition"
      }

      assertFalse(registry.register(malformed))
      assertEquals(404, registry.resolve(token, "/assets/app.js").status)
      assertTrue("a retry may safely acknowledge an already-denied token", registry.unregister(token))
      assertEquals(404, registry.resolve(token, "/assets/app.js").status)
    } finally {
      cacheRoot.toFile().deleteRecursively()
    }
  }

  @Test
  fun `rejects encoded traversal and Windows path spellings just like the Protocol policy table`() {
    val cacheRoot = Files.createTempDirectory("hosted-web-frame-test")
    try {
      val registry = HostedWebArtifactRegistry(cacheRoot.toFile())
      val token = "hpat_path_syntax_token"
      writeResource(cacheRoot, scriptStoredFileName, "console.log('frame')".toByteArray())
      writeResource(cacheRoot, entryStoredFileName, "<main>entry</main>".toByteArray())
      assertTrue(registry.register(registration(token, includeFallback = true)))

      for (requestPath in listOf(
        "/assets/%2e%2e/index.html",
        "/assets/.%2E/index.html",
        "/assets%2f..%2findex.html",
        "/C:/Windows/system32",
        "/%2fserver/share/index.html",
        "/assets\\\\server\\share/index.html"
      )) {
        assertEquals(400, registry.resolve(token, requestPath).status)
      }
    } finally {
      cacheRoot.toFile().deleteRecursively()
    }
  }

  private fun writeResource(root: java.nio.file.Path, storedFileName: String, bytes: ByteArray) {
    root.resolve("happier-plugin-ui-artifacts-v1")
      .resolve(accountKeyHash)
      .resolve(artifactKeyHash)
      .also { Files.createDirectories(it) }
      .resolve(storedFileName)
      .writeBytes(bytes)
  }

  private fun registration(token: String, includeFallback: Boolean = false): Map<String, Any?> = mapOf(
    "token" to token,
    "storagePartitionId" to "hpa_${"e".repeat(64)}",
    "storageLocator" to mapOf(
      "namespace" to "happier-plugin-ui-artifacts-v1",
      "accountKeyHash" to accountKeyHash,
      "artifactKeyHash" to artifactKeyHash
    ),
    "resources" to buildList {
      add(mapOf(
          "resourceId" to "r0",
          "storedFileName" to scriptStoredFileName,
          "digest" to sha256Digest(scriptBytes),
          "byteSize" to scriptBytes.size
      ))
      if (includeFallback) {
        add(mapOf(
            "resourceId" to "r1",
            "storedFileName" to entryStoredFileName,
            "digest" to sha256Digest(entryBytes),
            "byteSize" to entryBytes.size
        ))
      }
    },
    "policyTable" to buildMap<String, Any?> {
      put("version", 1)
      put("routes", listOf(
        mapOf(
          "path" to "assets/app.js",
          "outcome" to mapOf(
            "kind" to "content",
            "resourceId" to "r0",
            "contentType" to "text/javascript; charset=utf-8",
            "headers" to mapOf(
              "Cache-Control" to "public, max-age=31536000, immutable",
              "Content-Security-Policy" to "default-src 'none'",
              "ETag" to "\"${sha256Digest(scriptBytes)}\"",
              "X-Content-Type-Options" to "nosniff"
            )
          )
        ),
        mapOf(
          "path" to "assets/blob.bin",
          "outcome" to mapOf(
            "kind" to "rejected",
            "code" to "mime_type_not_allowed",
            "status" to 415
          )
        )
      ))
      if (includeFallback) {
        put("pathFallback", mapOf(
            "kind" to "content",
            "resourceId" to "r1",
            "contentType" to "text/html; charset=utf-8",
            "headers" to mapOf(
              "Cache-Control" to "public, max-age=31536000, immutable",
              "Content-Security-Policy" to "default-src 'none'",
              "ETag" to "\"${sha256Digest(entryBytes)}\"",
              "X-Content-Type-Options" to "nosniff"
            )
        ))
      }
    }
  )

  private fun sha256Digest(bytes: ByteArray): String {
    val hex = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { byte ->
      "%02x".format(byte)
    }
    return "sha256:$hex"
  }

  private companion object {
    val accountKeyHash = "a".repeat(64)
    val artifactKeyHash = "b".repeat(64)
    val scriptStoredFileName = "c".repeat(64) + ".bin"
    val entryStoredFileName = "d".repeat(64) + ".bin"
    val scriptBytes = "console.log('frame')".toByteArray()
    val entryBytes = "<main>entry</main>".toByteArray()
  }
}
