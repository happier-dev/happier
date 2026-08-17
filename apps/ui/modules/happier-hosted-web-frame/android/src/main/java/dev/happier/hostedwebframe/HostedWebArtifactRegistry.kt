package dev.happier.hostedwebframe

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * The native owner of registered opaque Artifact tokens. It receives only
 * Artifact's cache locator, stored-file names, opaque resource ids, and a
 * Protocol-produced response table. It never receives Artifact-relative
 * paths, byte arrays, or MIME/fallback policy inputs.
 *
 * `unregister` is deliberately synchronous. Once it returns true, a lookup
 * which starts afterwards cannot resolve the token. A lookup which already
 * holds the read lock is linearized before revocation and may finish its
 * already-admitted response; this is the boundary the JS registrar waits for
 * before withdrawing its own handle index or deleting cache bytes.
 */
internal class HostedWebArtifactRegistry(
  private val cacheDirectory: File
) {
  private val lock = ReentrantReadWriteLock()
  private val registrations = mutableMapOf<String, Registration>()
  private val canonicalCacheDirectory = cacheDirectory.canonicalFile

  fun register(input: Map<String, Any?>): Boolean {
    val registration = Registration.parse(input, canonicalCacheDirectory) ?: return false
    return lock.write {
      if (registrations.containsKey(registration.token)) return@write false
      if (!registration.resources.values.all { resource -> registration.resolveResourceFile(resource) != null }) {
        return@write false
      }
      registrations[registration.token] = registration
      true
    }
  }

  /**
   * Idempotent acknowledgement: an unknown token is already denied. Callers
   * must treat false/throw as a failed native revocation and retain their JS
   * registration for diagnostic/retry rather than deleting cache state.
   */
  fun unregister(token: String): Boolean = lock.write {
    if (!isOpaqueId(token)) return@write false
    registrations.remove(token)
    true
  }

  /** Process/module teardown is a native tombstone for every registered token. */
  fun clear(): Boolean = lock.write {
    registrations.clear()
    true
  }

  fun resolve(token: String, requestPath: String): HostedWebArtifactResponse = lock.read {
    resolveLocked(token, requestPath)
  }

  /**
   * Lets the WebView handler construct its response while the lookup is still
   * linearized against synchronous tombstoning. Do not retain the registration
   * or resource pointer outside [body].
   */
  fun <T> withResolved(
    token: String,
    requestPath: String,
    body: (HostedWebArtifactResponse) -> T
  ): T = lock.read {
    body(resolveLocked(token, requestPath))
  }

  fun originFor(token: String): String? = lock.read {
    registrations[token]?.origin
  }

  private fun resolveLocked(token: String, requestPath: String): HostedWebArtifactResponse {
    val registration = registrations[token] ?: return HostedWebArtifactResponse.rejected(404)
    val normalized = normalizeRequestPath(requestPath) ?: return HostedWebArtifactResponse.rejected(400)
    if (normalized.directoryRequest && normalized.path.isNotEmpty()) {
      return HostedWebArtifactResponse.rejected(404)
    }

    val matched = registration.table.routes[normalized.path]
    val selection = when {
      matched != null -> Selection(matched, fallback = false)
      registration.table.pathFallback != null && !hasFileExtension(normalized.path) -> {
        Selection(registration.table.pathFallback, fallback = true)
      }
      else -> return HostedWebArtifactResponse.rejected(404)
    }

    return when (val outcome = selection.outcome) {
      is PolicyOutcome.Rejected -> HostedWebArtifactResponse.rejected(outcome.status)
      is PolicyOutcome.Content -> {
        val resource = registration.resources[outcome.resourceId]
          ?: return HostedWebArtifactResponse.rejected(404)
        val bytes = registration.readResourceBytes(resource)
          ?: return HostedWebArtifactResponse.rejected(404)
        HostedWebArtifactResponse.content(
          resourceId = outcome.resourceId,
          contentType = outcome.contentType,
          headers = outcome.headers,
          bytes = bytes,
          fallback = selection.fallback
        )
      }
    }
  }

  private data class Selection(
    val outcome: PolicyOutcome,
    val fallback: Boolean
  )

  private data class Registration(
    val token: String,
    val origin: String,
    val baseDirectory: File,
    val resources: Map<String, Resource>,
    val table: PolicyTable
  ) {
    fun resolveResourceFile(resource: Resource): File? {
      return try {
        val candidate = File(baseDirectory, resource.storedFileName).canonicalFile
        if (candidate.parentFile != baseDirectory || !candidate.isFile || candidate.length() != resource.byteSize) {
          null
        } else {
          candidate
        }
      } catch (_: Exception) {
        null
      }
    }

    /**
     * The response must carry the exact bytes we verified. Returning a file
     * after hashing it would permit a later same-size replacement before the
     * WebView opens its stream.
     */
    fun readResourceBytes(resource: Resource): ByteArray? {
      val file = resolveResourceFile(resource) ?: return null
      return try {
        val bytes = file.readBytes()
        if (
          bytes.size.toLong() != resource.byteSize
          || sha256Digest(bytes) != resource.digest
        ) {
          null
        } else {
          bytes
        }
      } catch (_: Exception) {
        null
      }
    }

    companion object {
      fun parse(input: Map<String, Any?>, canonicalCacheDirectory: File): Registration? {
        if (!hasExactKeys(input, setOf("token", "storagePartitionId", "storageLocator", "resources", "policyTable"))) {
          return null
        }
        val token = input.string("token") ?: return null
        val partition = input.string("storagePartitionId") ?: return null
        if (!isOpaqueId(token) || !PARTITION_PATTERN.matches(partition)) return null
        val locator = StorageLocator.parse(input["storageLocator"]) ?: return null
        val baseDirectory = locator.resolveBaseDirectory(canonicalCacheDirectory) ?: return null
        val resources = parseResources(input["resources"]) ?: return null
        val table = PolicyTable.parse(input["policyTable"], resources.keys) ?: return null
        if (resources.keys != table.referencedResourceIds) return null
        return Registration(
          token = token,
          origin = "https://$partition.$HOSTED_WEB_DOMAIN",
          baseDirectory = baseDirectory,
          resources = resources,
          table = table
        )
      }
    }
  }

  private data class StorageLocator(
    val namespace: String,
    val accountKeyHash: String,
    val artifactKeyHash: String
  ) {
    fun resolveBaseDirectory(canonicalCacheDirectory: File): File? = try {
      val candidate = File(
        File(
          File(canonicalCacheDirectory, namespace),
          accountKeyHash
        ),
        artifactKeyHash
      ).canonicalFile
      if (!isContainedBy(candidate, canonicalCacheDirectory)) null else candidate
    } catch (_: Exception) {
      null
    }

    companion object {
      fun parse(value: Any?): StorageLocator? {
        val map = value.asStringMap() ?: return null
        if (!hasExactKeys(map, setOf("namespace", "accountKeyHash", "artifactKeyHash"))) return null
        val namespace = map.string("namespace") ?: return null
        val accountKeyHash = map.string("accountKeyHash") ?: return null
        val artifactKeyHash = map.string("artifactKeyHash") ?: return null
        if (
          namespace != PERSISTENT_ARTIFACT_NAMESPACE
          || !HASH_PATTERN.matches(accountKeyHash)
          || !HASH_PATTERN.matches(artifactKeyHash)
        ) {
          return null
        }
        return StorageLocator(namespace, accountKeyHash, artifactKeyHash)
      }
    }
  }

  private data class Resource(
    val resourceId: String,
    val storedFileName: String,
    val digest: String,
    val byteSize: Long
  )

  private sealed interface PolicyOutcome {
    data class Content(
      val resourceId: String,
      val contentType: String,
      val headers: Map<String, String>
    ) : PolicyOutcome

    data class Rejected(val status: Int) : PolicyOutcome
  }

  private data class PolicyTable(
    val routes: Map<String, PolicyOutcome>,
    val pathFallback: PolicyOutcome.Content?,
    val referencedResourceIds: Set<String>
  ) {
    companion object {
      fun parse(value: Any?, resourceIds: Set<String>): PolicyTable? {
        val map = value.asStringMap() ?: return null
        val allowedKeys = setOf("version", "routes", "pathFallback")
        if (map.keys.any { it !in allowedKeys } || map.keys.none { it == "version" } || map.keys.none { it == "routes" }) {
          return null
        }
        if (map.number("version") != 1L) return null
        val rawRoutes = map["routes"] as? List<*> ?: return null
        val routes = linkedMapOf<String, PolicyOutcome>()
        val referenced = linkedSetOf<String>()
        for (routeValue in rawRoutes) {
          val route = routeValue.asStringMap() ?: return null
          if (!hasExactKeys(route, setOf("path", "outcome"))) return null
          val path = route.string("path") ?: return null
          if (!isCanonicalPolicyPath(path) || routes.containsKey(path)) return null
          val outcome = parseOutcome(route["outcome"], resourceIds) ?: return null
          if (outcome is PolicyOutcome.Content) referenced += outcome.resourceId
          routes[path] = outcome
        }

        val fallback = if (map.containsKey("pathFallback")) {
          parseOutcome(map["pathFallback"], resourceIds) as? PolicyOutcome.Content ?: return null
        } else {
          null
        }
        if (fallback != null) referenced += fallback.resourceId
        return PolicyTable(routes, fallback, referenced)
      }

      private fun parseOutcome(value: Any?, resourceIds: Set<String>): PolicyOutcome? {
        val map = value.asStringMap() ?: return null
        return when (map.string("kind")) {
          "content" -> {
            if (!hasExactKeys(map, setOf("kind", "resourceId", "contentType", "headers"))) return null
            val resourceId = map.string("resourceId") ?: return null
            val contentType = map.string("contentType") ?: return null
            val headers = parseHeaders(map["headers"]) ?: return null
            if (!RESOURCE_ID_PATTERN.matches(resourceId) || resourceId !in resourceIds || contentType.isBlank()) {
              null
            } else {
              PolicyOutcome.Content(resourceId, contentType, headers)
            }
          }
          "rejected" -> {
            if (!hasExactKeys(map, setOf("kind", "code", "status"))) return null
            val code = map.string("code") ?: return null
            val status = map.number("status")?.toInt() ?: return null
            if (statusForPolicyFailure(code) != status) null else PolicyOutcome.Rejected(status)
          }
          else -> null
        }
      }
    }
  }

  companion object {
    private const val PERSISTENT_ARTIFACT_NAMESPACE = "happier-plugin-ui-artifacts-v1"
    private const val HOSTED_WEB_DOMAIN = "plugins.happier.dev"
    private val OPAQUE_ID_PATTERN = Regex("^[A-Za-z][A-Za-z0-9_-]{1,255}$")
    private val PARTITION_PATTERN = Regex("^hpa_[a-f0-9]{64}$")
    private val HASH_PATTERN = Regex("^[a-f0-9]{64}$")
    private val SHA256_DIGEST_PATTERN = Regex("^sha256:[a-f0-9]{64}$")
    private val RESOURCE_ID_PATTERN = Regex("^r(?:0|[1-9]\\d*)$")
    private val STORED_FILE_NAME_PATTERN = Regex("^[a-f0-9]{64}\\.bin$")
    private val WINDOWS_DRIVE_SEGMENT_PATTERN = Regex("(?:^|/)[A-Za-z]:")
    private val REQUIRED_HEADERS = setOf(
      "Cache-Control",
      "Content-Security-Policy",
      "ETag",
      "X-Content-Type-Options"
    )

    private fun parseResources(value: Any?): Map<String, Resource>? {
      val list = value as? List<*> ?: return null
      val resources = linkedMapOf<String, Resource>()
      for (item in list) {
        val map = item.asStringMap() ?: return null
        if (!hasExactKeys(map, setOf("resourceId", "storedFileName", "digest", "byteSize"))) return null
        val resourceId = map.string("resourceId") ?: return null
        val storedFileName = map.string("storedFileName") ?: return null
        val digest = map.string("digest") ?: return null
        val byteSize = map.number("byteSize") ?: return null
        if (
          !RESOURCE_ID_PATTERN.matches(resourceId)
          || resources.containsKey(resourceId)
          || !STORED_FILE_NAME_PATTERN.matches(storedFileName)
          || !SHA256_DIGEST_PATTERN.matches(digest)
          || byteSize < 0L
        ) {
          return null
        }
        resources[resourceId] = Resource(resourceId, storedFileName, digest, byteSize)
      }
      return resources
    }

    private fun parseHeaders(value: Any?): Map<String, String>? {
      val map = value.asStringMap() ?: return null
      if (!hasExactKeys(map, REQUIRED_HEADERS)) return null
      val headers = linkedMapOf<String, String>()
      for (name in REQUIRED_HEADERS) {
        val header = map.string(name) ?: return null
        if (header.isBlank()) return null
        headers[name] = header
      }
      return headers
    }

    private fun normalizeRequestPath(requestPath: String): NormalizedRequestPath? {
      val rawPath = requestPath.substringBefore('?')
      // Keep this identical to Protocol's native-table policy boundary. In
      // particular, do this before decoding the complete path: an encoded
      // separator or dot segment changes the grammar a WebView handler sees.
      if (hasEncodedTraversalOrSeparator(rawPath)) return null
      val decoded = decodePercentEncodedPath(rawPath) ?: return null
      if (decoded.indexOf('\u0000') >= 0 || hasWindowsPathSyntax(decoded)) return null
      val directoryRequest = decoded.endsWith('/')
      val trimmed = decoded.trimStart('/')
      if (trimmed.isEmpty()) return NormalizedRequestPath("", directoryRequest = false)
      val normalized = normalizeArtifactPath(trimmed) ?: return null
      return NormalizedRequestPath(normalized, directoryRequest)
    }

    private fun isCanonicalPolicyPath(path: String): Boolean {
      if (path.indexOf('\u0000') >= 0) return false
      if (path.isEmpty()) return true
      return normalizeArtifactPath(path) == path
    }

    private fun normalizeArtifactPath(path: String): String? {
      if (path.indexOf('\u0000') >= 0 || hasWindowsPathSyntax(path)) return null
      val trimmed = path.trim().trim('/')
      if (trimmed.isEmpty()) return null
      val segments = mutableListOf<String>()
      for (segment in trimmed.split('/')) {
        when (segment) {
          "", "." -> Unit
          ".." -> {
            if (segments.isEmpty()) return null
            segments.removeAt(segments.lastIndex)
          }
          else -> segments += segment
        }
      }
      return segments.takeIf { it.isNotEmpty() }?.joinToString("/")
    }

    private fun hasWindowsPathSyntax(path: String): Boolean =
      path.contains('\\')
        || path.startsWith("//")
        || path.startsWith("\\\\")
        || WINDOWS_DRIVE_SEGMENT_PATTERN.containsMatchIn(path)

    private fun hasEncodedTraversalOrSeparator(rawPath: String): Boolean {
      for (rawSegment in rawPath.split('/')) {
        if (!rawSegment.contains('%')) continue
        val decodedSegment = decodePercentEncodedPath(rawSegment) ?: return true
        if (
          decodedSegment == "."
          || decodedSegment == ".."
          || decodedSegment.contains('/')
          || decodedSegment.contains('\\')
        ) {
          return true
        }
      }
      return false
    }

    private fun decodePercentEncodedPath(value: String): String? {
      if (!value.contains('%')) return value
      val decoded = StringBuilder()
      var index = 0
      while (index < value.length) {
        val character = value[index]
        if (character != '%') {
          decoded.append(character)
          index += 1
          continue
        }
        val bytes = ByteArrayOutputStream()
        while (index < value.length && value[index] == '%') {
          if (index + 2 >= value.length) return null
          val high = value[index + 1].digitToIntOrNull(16) ?: return null
          val low = value[index + 2].digitToIntOrNull(16) ?: return null
          bytes.write((high shl 4) or low)
          index += 3
        }
        val percentDecoded = try {
          StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes.toByteArray()))
            .toString()
        } catch (_: CharacterCodingException) {
          return null
        }
        decoded.append(percentDecoded)
      }
      return decoded.toString()
    }

    private fun hasFileExtension(path: String): Boolean {
      val basename = path.substringAfterLast('/')
      return basename.lastIndexOf('.') > 0
    }

    private fun statusForPolicyFailure(code: String): Int? = when (code) {
      "invalid_request_path" -> 400
      "mime_type_not_allowed" -> 415
      "asset_not_declared", "directory_listing_disabled", "source_map_unavailable" -> 404
      else -> null
    }

    private fun isOpaqueId(value: String): Boolean = OPAQUE_ID_PATTERN.matches(value)

    private fun sha256Digest(bytes: ByteArray): String = buildString(71) {
      append("sha256:")
      for (byte in MessageDigest.getInstance("SHA-256").digest(bytes)) {
        val value = byte.toInt() and 0xff
        append(HEX_DIGITS[value ushr 4])
        append(HEX_DIGITS[value and 0x0f])
      }
    }

    private fun isContainedBy(candidate: File, root: File): Boolean {
      return candidate == root || candidate.path.startsWith("${root.path}${File.separator}")
    }

    private fun Any?.asStringMap(): Map<String, Any?>? {
      val raw = this as? Map<*, *> ?: return null
      val result = linkedMapOf<String, Any?>()
      for ((key, value) in raw) {
        val stringKey = key as? String ?: return null
        if (result.put(stringKey, value) != null) return null
      }
      return result
    }

    private fun Map<String, Any?>.string(key: String): String? = this[key] as? String

    private fun Map<String, Any?>.number(key: String): Long? {
      val value = this[key] as? Number ?: return null
      val asLong = value.toLong()
      return if (value.toDouble().isFinite() && value.toDouble() == asLong.toDouble()) asLong else null
    }

    private fun hasExactKeys(map: Map<String, Any?>, expected: Set<String>): Boolean = map.keys == expected

    private const val HEX_DIGITS = "0123456789abcdef"
  }
}

internal data class HostedWebArtifactResponse private constructor(
  val status: Int,
  val resourceId: String?,
  val contentType: String?,
  val headers: Map<String, String>,
  val bytes: ByteArray?,
  val fallback: Boolean
) {
  companion object {
    fun rejected(status: Int): HostedWebArtifactResponse = HostedWebArtifactResponse(
      status = status,
      resourceId = null,
      contentType = null,
      headers = emptyMap(),
      bytes = null,
      fallback = false
    )

    fun content(
      resourceId: String,
      contentType: String,
      headers: Map<String, String>,
      bytes: ByteArray,
      fallback: Boolean
    ): HostedWebArtifactResponse = HostedWebArtifactResponse(
      status = 200,
      resourceId = resourceId,
      contentType = contentType,
      headers = headers,
      bytes = bytes,
      fallback = fallback
    )
  }
}

private data class NormalizedRequestPath(
  val path: String,
  val directoryRequest: Boolean
)
