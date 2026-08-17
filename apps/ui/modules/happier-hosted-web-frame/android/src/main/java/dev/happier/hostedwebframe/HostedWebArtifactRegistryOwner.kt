package dev.happier.hostedwebframe

import android.content.Context
import java.io.File

/**
 * One process-local owner for opaque native Artifact tokens. The Expo module
 * registers and tombstones tokens; each exported view resolves through this
 * same registry. It is deliberately not a byte cache or a second persistence
 * layer—the Artifact cache remains the source of the stored files.
 */
internal object HostedWebArtifactRegistryOwner {
  private val monitor = Any()
  private var registry: HostedWebArtifactRegistry? = null
  private var cacheDirectory: File? = null

  fun register(context: Context, input: Map<String, Any?>): Boolean = registryFor(context).register(input)

  fun unregister(context: Context, token: String): Boolean = registryFor(context).unregister(token)

  fun originFor(context: Context, token: String): String? = registryFor(context).originFor(token)

  fun <T> withResolved(
    context: Context,
    token: String,
    requestPath: String,
    body: (HostedWebArtifactResponse) -> T
  ): T = registryFor(context).withResolved(token, requestPath, body)

  fun clear() {
    synchronized(monitor) {
      registry?.clear()
      registry = null
      cacheDirectory = null
    }
  }

  private fun registryFor(context: Context): HostedWebArtifactRegistry {
    val currentCacheDirectory = context.cacheDir.canonicalFile
    synchronized(monitor) {
      val existing = registry
      if (existing != null && cacheDirectory == currentCacheDirectory) return existing
      // A changed application cache root cannot retain authority from the old
      // root. Tombstone before publishing the replacement registry.
      existing?.clear()
      return HostedWebArtifactRegistry(currentCacheDirectory).also {
        registry = it
        cacheDirectory = currentCacheDirectory
      }
    }
  }
}
