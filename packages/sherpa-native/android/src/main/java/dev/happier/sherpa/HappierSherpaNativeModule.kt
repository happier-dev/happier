package dev.happier.sherpa

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel

/**
 * Dedicated single-thread worker for the blocking sherpa calls.
 *
 * Expo dispatches every `AsyncFunction` on one shared *serial* queue
 * (`AppContext.modulesQueue`, backed by the single `expo.modules.AsyncFunctionQueue`
 * handler thread), so a function that blocks it blocks every other function --
 * including its own cancellation. Sherpa's synthesis and decode calls are
 * synchronous and multi-second, so they run here instead, leaving the default
 * queue free for `cancel` and `releaseAssetsDir` to land while work is in flight.
 */
internal class SherpaWorker(name: String) {
  private val dispatcher: ExecutorCoroutineDispatcher =
    Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, name).apply { isDaemon = true }
    }.asCoroutineDispatcher()

  val scope = CoroutineScope(dispatcher + SupervisorJob())

  fun shutdown() {
    scope.cancel()
    dispatcher.close()
  }
}

class HappierSherpaNativeModule internal constructor(
  private val createVadRegistry: (() -> FrameFedVadDetectorRegistryControl)? = null,
  // Injected for the same reason as the VAD registry: the JNI library is allowed
  // to be absent (see `HappierSherpaNativeJni`), so teardown must be drivable
  // without it.
  private val releaseAllNative: () -> Unit = { HappierSherpaNativeJni.nativeReleaseAll() }
) : Module() {
  // TTS and ASR get one worker each because they run concurrently during a
  // conversation: the assistant is speaking while the microphone stays open for
  // barge-in. Sharing a worker would stall live capture frames behind a
  // multi-second synthesis and trip the capture queue's backpressure guard.
  internal val ttsWorker = SherpaWorker("happier-sherpa-tts")
  internal val asrWorker = SherpaWorker("happier-sherpa-asr")
  private var vadRegistry: FrameFedVadDetectorRegistryControl? = null

  internal fun getOrCreateVadRegistry(): FrameFedVadDetectorRegistryControl {
    val existing = vadRegistry
    if (existing != null) {
      return existing
    }

    val created = createVadRegistry?.invoke() ?: run {
      val reactContext = appContext.reactContext
        ?: throw Exception("React context is unavailable")
      FrameFedVadDetectorRegistry(context = reactContext.applicationContext)
    }
    vadRegistry = created
    return created
  }

  internal fun handleModuleDestroy() {
    // Streaming recognizers and offline TTS engines live in the process-wide
    // native caches, so they are released here rather than dying with this module
    // instance. Releasing before the workers stop is what lets a blocked
    // synthesis or decode observe its cancellation and unwind.
    releaseAllNative()
    ttsWorker.shutdown()
    asrWorker.shutdown()
    val registry = vadRegistry ?: return
    vadRegistry = null
    registry.cancelAll()
  }

  private fun requireAssetsDir(params: Map<String, Any?>): String {
    val assetsDir = params["assetsDir"] as? String ?: ""
    if (assetsDir.isBlank()) throw Exception("assetsDir is required")
    return assetsDir
  }

  private fun requireEngine(assetsDir: String) {
    if (HappierSherpaNativeJni.nativeEnsureEngine(assetsDir) != 1) {
      throw Exception("Failed to initialize sherpa offline TTS engine (assets may be missing)")
    }
  }

  override fun definition() = ModuleDefinition {
    Name("HappierSherpaNative")
    OnDestroy {
      handleModuleDestroy()
    }

    AsyncFunction("initialize") { params: Map<String, Any?> ->
      requireEngine(requireAssetsDir(params))
    }.runOnQueue(ttsWorker.scope)

    AsyncFunction("listVoices") { params: Map<String, Any?> ->
      val assetsDir = requireAssetsDir(params)
      requireEngine(assetsDir)
      val n = HappierSherpaNativeJni.nativeGetNumSpeakers(assetsDir)
      if (n <= 0) return@AsyncFunction emptyList<Map<String, Any?>>()

      return@AsyncFunction (0 until n).map { i ->
        mapOf(
          "id" to "sid:$i",
          "title" to "Speaker $i",
          "sid" to i
        )
      }
    }.runOnQueue(ttsWorker.scope)

    AsyncFunction("synthesizeToWavFile") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      val assetsDir = requireAssetsDir(params)
      val text = params["text"] as? String ?: ""
      val outWavPath = params["outWavPath"] as? String ?: ""
      val sid = (params["sid"] as? Number)?.toInt() ?: 0
      val speed = ((params["speed"] as? Number)?.toDouble() ?: 1.0).toFloat()

      if (jobId.isBlank()) throw Exception("jobId is required")
      if (text.isBlank()) throw Exception("text is required")
      if (outWavPath.isBlank()) throw Exception("outWavPath is required")

      val sampleRate =
        HappierSherpaNativeJni.nativeSynthesizeToWavFile(assetsDir, text, sid, speed, outWavPath, jobId)
      if (sampleRate <= 0) {
        throw Exception("Synthesis failed")
      }

      return@AsyncFunction mapOf("wavPath" to outWavPath, "sampleRate" to sampleRate)
    }.runOnQueue(ttsWorker.scope)

    // Left on the default queue on purpose: the native registries own their
    // locking, so the mark lands while a worker is still inside a synthesis or a
    // decode. Moving this onto a worker would make it queue behind the very work
    // it cancels, which is what made cancellation unreachable before.
    AsyncFunction("cancel") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      if (jobId.isBlank()) return@AsyncFunction
      HappierSherpaNativeJni.nativeCancel(jobId)
    }

    AsyncFunction("createStreamingRecognizer") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      val assetsDir = requireAssetsDir(params)
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16000
      val channels = (params["channels"] as? Number)?.toInt() ?: 1
      val language = params["language"] as? String

      if (jobId.isBlank()) throw Exception("jobId is required")

      val ok = HappierSherpaNativeJni.nativeCreateStreamingRecognizer(jobId, assetsDir, sampleRate, channels, language ?: "")
      if (ok != 1) {
        throw Exception("Failed to initialize sherpa streaming ASR (assets may be missing)")
      }
    }.runOnQueue(asrWorker.scope)

    AsyncFunction("pushAudioFrame") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      val pcm16leBase64 = params["pcm16leBase64"] as? String ?: ""
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16000
      val channels = (params["channels"] as? Number)?.toInt() ?: 1

      if (jobId.isBlank()) throw Exception("jobId is required")

      val bytes = if (pcm16leBase64.isBlank()) ByteArray(0) else Base64.decode(pcm16leBase64, Base64.DEFAULT)
      return@AsyncFunction HappierSherpaNativeJni.nativePushAudioFrame(jobId, bytes, sampleRate, channels)
        ?: throw Exception("ASR stream not found")
    }.runOnQueue(asrWorker.scope)

    AsyncFunction("finishStreaming") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      if (jobId.isBlank()) throw Exception("jobId is required")
      return@AsyncFunction HappierSherpaNativeJni.nativeFinishStreaming(jobId)
        ?: throw Exception("ASR stream finalization returned no result")
    }.runOnQueue(asrWorker.scope)

    // Left on the default queue on purpose: pack invalidation must preempt the
    // work it is retiring, not queue behind it.
    AsyncFunction("releaseAssetsDir") { params: Map<String, Any?> ->
      val assetsDir = requireAssetsDir(params)
      val counts = HappierSherpaNativeJni.nativeReleaseAssetsDir(assetsDir)
      return@AsyncFunction mapOf<String, Any>(
        "cancelledJobs" to (counts.getOrNull(0) ?: 0),
        "releasedEngines" to (counts.getOrNull(1) ?: 0)
      )
    }

    AsyncFunction("createVadDetector") { params: Map<String, Any?> ->
      val detectorId = params["detectorId"] as? String ?: ""
      val minSpeechMs = (params["minSpeechMs"] as? Number)?.toLong() ?: 0L
      val redemptionMs = (params["redemptionMs"] as? Number)?.toLong() ?: 0L
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16_000

      getOrCreateVadRegistry().create(
        detectorId = detectorId,
        sampleRate = sampleRate,
        minSpeechMs = minSpeechMs,
        redemptionMs = redemptionMs
      )
    }

    AsyncFunction("pushVadAudioFrame") { params: Map<String, Any?> ->
      val detectorId = params["detectorId"] as? String ?: ""
      val pcm16leBase64 = params["pcm16leBase64"] as? String ?: ""
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16_000
      val channels = (params["channels"] as? Number)?.toInt() ?: 1
      val bytes = if (pcm16leBase64.isBlank()) ByteArray(0) else Base64.decode(pcm16leBase64, Base64.DEFAULT)
      require(bytes.size % 2 == 0) { "pcm16leBase64 must contain complete PCM16 samples" }
      val pcm16 = ShortArray(bytes.size / 2) { index ->
        val low = bytes[index * 2].toInt() and 0xff
        val high = bytes[index * 2 + 1].toInt() and 0xff
        ((high shl 8) or low).toShort()
      }
      val result = getOrCreateVadRegistry().push(detectorId, pcm16, sampleRate, channels)
      return@AsyncFunction mapOf(
        "speechStarted" to result.speechStarted,
        "speechEnded" to result.speechEnded
      )
    }

    AsyncFunction("cancelVadDetector") { params: Map<String, Any?> ->
      val detectorId = params["detectorId"] as? String ?: ""
      if (detectorId.isBlank()) return@AsyncFunction
      getOrCreateVadRegistry().cancel(detectorId)
    }
  }
}

object HappierSherpaNativeJni {
  init {
    try {
      System.loadLibrary("happier_sherpa_jni")
    } catch (_: Throwable) {
      // ignored; JS will treat module as unavailable if it can't initialize.
    }
  }

  external fun nativeEnsureEngine(assetsDir: String): Int
  external fun nativeGetNumSpeakers(assetsDir: String): Int
  external fun nativeSynthesizeToWavFile(assetsDir: String, text: String, sid: Int, speed: Float, outWavPath: String, jobId: String): Int
  external fun nativeCancel(jobId: String)

  external fun nativeCreateStreamingRecognizer(jobId: String, assetsDir: String, sampleRate: Int, channels: Int, language: String): Int
  external fun nativePushAudioFrame(jobId: String, pcm16le: ByteArray, sampleRate: Int, channels: Int): Map<String, Any?>?
  /** `{ status: "finalized", text }`, `{ status: "cancelled" }`, or `{ status: "missing" }`. */
  external fun nativeFinishStreaming(jobId: String): Map<String, Any?>?

  /** `[cancelledJobs, releasedEngines]` for one assets directory. */
  external fun nativeReleaseAssetsDir(assetsDir: String): IntArray

  /** `[cancelledJobs, releasedEngines]` across every cached pack. */
  external fun nativeReleaseAll(): IntArray

  external fun nativeCreateVadSession(modelPath: String, sampleRate: Int, minSpeechSec: Float, minSilenceSec: Float): Long
  external fun nativeVadAcceptPcm16(handle: Long, pcm16: ShortArray, count: Int, channels: Int): Int
  external fun nativeDestroyVadSession(handle: Long)
}
