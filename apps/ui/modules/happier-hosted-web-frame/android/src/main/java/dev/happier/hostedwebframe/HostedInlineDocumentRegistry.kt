package dev.happier.hostedwebframe

import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/** Process-local, synchronously revocable source for caller-authored HTML. */
internal object HostedInlineDocumentRegistry {
  private val lock = ReentrantReadWriteLock()
  private data class Document(val bytes: ByteArray, val contentSecurityPolicy: String)
  private val documents = mutableMapOf<String, Document>()

  fun register(input: Map<String, Any?>): Boolean {
    if (input.keys != setOf("token", "html", "contentSecurityPolicy")) return false
    val token = input["token"] as? String ?: return false
    val html = input["html"] as? String ?: return false
    val contentSecurityPolicy = input["contentSecurityPolicy"] as? String ?: return false
    if (contentSecurityPolicy != "sandbox allow-scripts") return false
    if (!isToken(token)) return false
    return lock.write {
      if (documents.containsKey(token)) return@write false
      documents[token] = Document(html.toByteArray(Charsets.UTF_8), contentSecurityPolicy)
      true
    }
  }

  fun unregister(token: String): Boolean = lock.write {
    if (!isToken(token)) return@write false
    documents.remove(token)
    true
  }

  fun clear() = lock.write { documents.clear() }

  fun originFor(token: String): String? = lock.read {
    if (!documents.containsKey(token)) null else "https://$token.plugins.happier.dev"
  }

  fun isCurrentDocumentUrl(token: String, url: String): Boolean = lock.read {
    // A fragment changes the document's location, not its registered identity.
    // Query strings, paths and every other origin must still match exactly.
    documents.containsKey(token) && url.substringBefore('#') == "https://$token.plugins.happier.dev/"
  }

  fun <T> withResolved(token: String, requestPath: String, body: (HostedWebArtifactResponse) -> T): T = lock.read {
    val document = documents[token]
    val response = if (document != null && requestPath == "/") {
      HostedWebArtifactResponse.content(
        resourceId = "inline-document",
        contentType = "text/html; charset=utf-8",
        headers = mapOf(
          "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff",
          "Content-Security-Policy" to document.contentSecurityPolicy
        ),
        bytes = document.bytes,
        fallback = false
      )
    } else {
      HostedWebArtifactResponse.rejected(if (requestPath.startsWith("/")) 404 else 400)
    }
    body(response)
  }

  private fun isToken(value: String): Boolean = value.length == 68
    && value.startsWith("hpa_")
    && value.drop(4).all { it in 'a'..'f' || it in '0'..'9' }
}
