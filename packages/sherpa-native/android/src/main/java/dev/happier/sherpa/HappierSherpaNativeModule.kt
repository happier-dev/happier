package dev.happier.sherpa

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

private class SynthesisCancelledException : Exception("Synthesis cancelled")

class HappierSherpaNativeModule : Module() {
  // Expo runs every AsyncFunction of every module on one shared thread. Synthesis takes seconds, so TTS and
  // ASR work runs on their own executors: cancel, mic frames and other modules never wait behind synthesis.
  private val ttsExecutor: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "HappierSherpaTts") }
  private val asrExecutor: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "HappierSherpaAsr") }

  // Touched only on ttsExecutor, so a handle is never destroyed while a synthesis uses it.
  private val ttsEnginesByAssetsDir = HashMap<String, Long>()

  // Callers derive assetsDir from directory URIs that may carry a trailing slash; one dir is one engine.
  private fun normalizeAssetsDir(assetsDir: String): String = assetsDir.trim().trimEnd('/')

  // Runs only on ttsExecutor, so creation is serialized.
  private fun requireEngine(rawAssetsDir: String): Long {
    val assetsDir = normalizeAssetsDir(rawAssetsDir)
    if (assetsDir.isEmpty()) throw Exception("assetsDir is required")
    ttsEnginesByAssetsDir[assetsDir]?.let { return it }

    val created = HappierSherpaNativeJni.nativeCreateEngine(assetsDir)
    if (created == 0L) {
      throw Exception("Failed to initialize sherpa offline TTS engine (assets may be missing)")
    }
    ttsEnginesByAssetsDir[assetsDir] = created
    return created
  }

  // Runs only on ttsExecutor.
  private fun destroyTtsEngine(assetsDir: String) {
    ttsEnginesByAssetsDir.remove(assetsDir)?.let { HappierSherpaNativeJni.nativeDestroyEngine(it) }
  }

  private fun reject(promise: Promise, e: Throwable) {
    val code = if (e is SynthesisCancelledException) "ERR_HAPPIER_SHERPA_CANCELLED" else "ERR_HAPPIER_SHERPA"
    promise.reject(code, e.message ?: e.toString(), e)
  }

  // Settles the promise even when the executor is already shut down (module destroyed).
  private fun runOn(executor: ExecutorService, promise: Promise, block: () -> Any?) {
    try {
      executor.execute {
        try {
          promise.resolve(block())
        } catch (e: Throwable) {
          reject(promise, e)
        }
      }
    } catch (e: RejectedExecutionException) {
      reject(promise, e)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("HappierSherpaNative")

    OnDestroy {
      // Queued after any running synthesis, so no handle is destroyed while in use.
      ttsExecutor.execute { ttsEnginesByAssetsDir.keys.toList().forEach(::destroyTtsEngine) }
      ttsExecutor.shutdown()
      asrExecutor.shutdown()
    }

    AsyncFunction("initialize") { params: Map<String, Any?>, promise: Promise ->
      val assetsDir = params["assetsDir"] as? String ?: ""
      runOn(ttsExecutor, promise) {
        requireEngine(assetsDir)
        null
      }
    }

    AsyncFunction("listVoices") { params: Map<String, Any?>, promise: Promise ->
      val assetsDir = params["assetsDir"] as? String ?: ""
      runOn(ttsExecutor, promise) {
        val n = HappierSherpaNativeJni.nativeGetNumSpeakers(requireEngine(assetsDir))
        (0 until maxOf(n, 0)).map { i ->
          mapOf(
            "id" to "sid:$i",
            "title" to "Speaker $i",
            "sid" to i
          )
        }
      }
    }

    AsyncFunction("synthesizeToWavFile") { params: Map<String, Any?>, promise: Promise ->
      val jobId = params["jobId"] as? String ?: ""
      val assetsDir = params["assetsDir"] as? String ?: ""
      val text = params["text"] as? String ?: ""
      val outWavPath = params["outWavPath"] as? String ?: ""
      val sid = (params["sid"] as? Number)?.toInt() ?: 0
      val speed = ((params["speed"] as? Number)?.toDouble() ?: 1.0).toFloat()

      val invalid = when {
        jobId.isBlank() -> "jobId is required"
        text.isBlank() -> "text is required"
        outWavPath.isBlank() -> "outWavPath is required"
        else -> null
      }
      if (invalid != null) {
        reject(promise, Exception(invalid))
        return@AsyncFunction
      }

      // Registered here, on Expo's serial function queue, so a later `cancel` call always finds the job even
      // while it waits behind another synthesis. Every path below ends by forgetting it.
      HappierSherpaNativeJni.nativeAcceptSynthesis(jobId)
      try {
        ttsExecutor.execute {
          try {
            val engine = requireEngine(assetsDir)
            when (HappierSherpaNativeJni.nativeSynthesizeToWavFile(engine, text, sid, speed, outWavPath, jobId)) {
              HappierSherpaNativeJni.SYNTHESIS_OK -> Unit
              HappierSherpaNativeJni.SYNTHESIS_CANCELLED -> throw SynthesisCancelledException()
              else -> throw Exception("Synthesis failed")
            }
            promise.resolve(mapOf("wavPath" to outWavPath, "sampleRate" to HappierSherpaNativeJni.nativeGetSampleRate(engine)))
          } catch (e: Throwable) {
            reject(promise, e)
          } finally {
            HappierSherpaNativeJni.nativeForgetSynthesis(jobId)
          }
        }
      } catch (e: RejectedExecutionException) {
        HappierSherpaNativeJni.nativeForgetSynthesis(jobId)
        reject(promise, e)
      }
    }

    AsyncFunction("cancel") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      if (jobId.isBlank()) return@AsyncFunction
      // TTS: flags an accepted job, queued or running, without waiting behind the synthesis it stops; unknown
      // ids are ignored. Synthesis polls the flag.
      HappierSherpaNativeJni.nativeCancel(jobId)
      // ASR: cancels the streaming job with this id, if any.
      // Streams are only touched on the ASR executor, so destroying one never races a frame being decoded.
      try {
        asrExecutor.execute { HappierSherpaNativeJni.nativeCancelStreaming(jobId) }
      } catch (_: RejectedExecutionException) {
        // Module destroyed: its streams are gone with it.
      }
    }

    AsyncFunction("release") { params: Map<String, Any?>, promise: Promise ->
      val assetsDir = normalizeAssetsDir(params["assetsDir"] as? String ?: "")
      if (assetsDir.isEmpty()) {
        promise.resolve(null)
        return@AsyncFunction
      }
      // Queued behind any synthesis or frame that is already using the engine.
      runOn(ttsExecutor, promise) {
        destroyTtsEngine(assetsDir)
        // Running ASR streams keep their engine alive natively, so this need not wait for the ASR executor.
        HappierSherpaNativeJni.nativeReleaseAsrEngine(assetsDir)
        null
      }
    }

    // Android Auto Backup already excludes app files (the app's backup rules include only shared preferences).
    AsyncFunction("excludeFromBackup") { _: Map<String, Any?> -> }

    AsyncFunction("createStreamingRecognizer") { params: Map<String, Any?>, promise: Promise ->
      val jobId = params["jobId"] as? String ?: ""
      val assetsDir = normalizeAssetsDir(params["assetsDir"] as? String ?: "")
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16000
      val channels = (params["channels"] as? Number)?.toInt() ?: 1
      val language = params["language"] as? String

      runOn(asrExecutor, promise) {
        if (jobId.isBlank()) throw Exception("jobId is required")
        if (assetsDir.isEmpty()) throw Exception("assetsDir is required")

        val ok = HappierSherpaNativeJni.nativeCreateStreamingRecognizer(jobId, assetsDir, sampleRate, channels, language ?: "")
        if (ok != 1) throw Exception("Failed to initialize sherpa streaming ASR (assets may be missing)")
        null
      }
    }

    AsyncFunction("pushAudioFrame") { params: Map<String, Any?>, promise: Promise ->
      val jobId = params["jobId"] as? String ?: ""
      val pcm16leBase64 = params["pcm16leBase64"] as? String ?: ""
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16000
      val channels = (params["channels"] as? Number)?.toInt() ?: 1

      runOn(asrExecutor, promise) {
        if (jobId.isBlank()) throw Exception("jobId is required")
        val bytes = if (pcm16leBase64.isBlank()) ByteArray(0) else Base64.decode(pcm16leBase64, Base64.DEFAULT)
        HappierSherpaNativeJni.nativePushAudioFrame(jobId, bytes, sampleRate, channels)
      }
    }

    AsyncFunction("finishStreaming") { params: Map<String, Any?>, promise: Promise ->
      val jobId = params["jobId"] as? String ?: ""
      runOn(asrExecutor, promise) {
        if (jobId.isBlank()) throw Exception("jobId is required")
        mapOf("text" to HappierSherpaNativeJni.nativeFinishStreaming(jobId))
      }
    }
  }
}

object HappierSherpaNativeJni {
  // nativeSynthesizeToWavFile results; mirror kSynthesis* in HappierSherpaNativeJni.cpp.
  const val SYNTHESIS_FAILED = 0
  const val SYNTHESIS_OK = 1
  const val SYNTHESIS_CANCELLED = 2

  init {
    try {
      System.loadLibrary("happier_sherpa_jni")
    } catch (_: Throwable) {
      // ignored; JS will treat module as unavailable if it can't initialize.
    }
  }

  external fun nativeCreateEngine(assetsDir: String): Long
  external fun nativeDestroyEngine(handle: Long)
  external fun nativeGetSampleRate(handle: Long): Int
  external fun nativeGetNumSpeakers(handle: Long): Int
  external fun nativeSynthesizeToWavFile(handle: Long, text: String, sid: Int, speed: Float, outWavPath: String, jobId: String): Int
  external fun nativeCancel(jobId: String)
  external fun nativeAcceptSynthesis(jobId: String)
  external fun nativeForgetSynthesis(jobId: String)

  external fun nativeCreateStreamingRecognizer(jobId: String, assetsDir: String, sampleRate: Int, channels: Int, language: String): Int
  external fun nativePushAudioFrame(jobId: String, pcm16le: ByteArray, sampleRate: Int, channels: Int): Map<String, Any?>
  external fun nativeFinishStreaming(jobId: String): String
  external fun nativeCancelStreaming(jobId: String)
  external fun nativeReleaseAsrEngine(assetsDir: String)
}
