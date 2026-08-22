package dev.happier.sherpa

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap

class HappierSherpaNativeModule internal constructor(
  private val createVadRegistry: (() -> FrameFedVadDetectorRegistryControl)? = null,
  // Injected for the same reason as the VAD registry: the JNI library is allowed
  // to be absent (see `HappierSherpaNativeJni`), so teardown must be drivable
  // without it.
  private val releaseAllStreaming: () -> Unit = { HappierSherpaNativeJni.nativeReleaseAllStreaming() }
) : Module() {
  private val enginesByAssetsDir = ConcurrentHashMap<String, Long>()
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
    // Streaming ASR state lives in the process-wide native registry, so it is
    // released here rather than dying with this module instance.
    releaseAllStreaming()
    val registry = vadRegistry ?: return
    vadRegistry = null
    registry.cancelAll()
  }

  private fun requireEngine(assetsDir: String): Long {
    if (assetsDir.isBlank()) throw Exception("assetsDir is required")
    val existing = enginesByAssetsDir[assetsDir]
    if (existing != null && existing != 0L) return existing

    val created = HappierSherpaNativeJni.nativeCreateEngine(assetsDir)
    if (created == 0L) {
      throw Exception("Failed to initialize sherpa offline TTS engine (assets may be missing)")
    }
    enginesByAssetsDir[assetsDir] = created
    return created
  }

  override fun definition() = ModuleDefinition {
    Name("HappierSherpaNative")
    OnDestroy {
      handleModuleDestroy()
    }

    AsyncFunction("initialize") { params: Map<String, Any?> ->
      val assetsDir = params["assetsDir"] as? String ?: ""
      requireEngine(assetsDir)
    }

    AsyncFunction("listVoices") { params: Map<String, Any?> ->
      val assetsDir = params["assetsDir"] as? String ?: ""
      val engine = requireEngine(assetsDir)
      val n = HappierSherpaNativeJni.nativeGetNumSpeakers(engine)
      if (n <= 0) return@AsyncFunction emptyList<Map<String, Any?>>()

      return@AsyncFunction (0 until n).map { i ->
        mapOf(
          "id" to "sid:$i",
          "title" to "Speaker $i",
          "sid" to i
        )
      }
    }

    AsyncFunction("synthesizeToWavFile") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      val assetsDir = params["assetsDir"] as? String ?: ""
      val text = params["text"] as? String ?: ""
      val outWavPath = params["outWavPath"] as? String ?: ""
      val sid = (params["sid"] as? Number)?.toInt() ?: 0
      val speed = ((params["speed"] as? Number)?.toDouble() ?: 1.0).toFloat()

      if (jobId.isBlank()) throw Exception("jobId is required")
      if (text.isBlank()) throw Exception("text is required")
      if (outWavPath.isBlank()) throw Exception("outWavPath is required")

      val engine = requireEngine(assetsDir)
      val ok = HappierSherpaNativeJni.nativeSynthesizeToWavFile(engine, text, sid, speed, outWavPath, jobId)
      if (ok != 1) {
        throw Exception("Synthesis failed")
      }

      val sampleRate = HappierSherpaNativeJni.nativeGetSampleRate(engine)
      return@AsyncFunction mapOf("wavPath" to outWavPath, "sampleRate" to sampleRate)
    }

    AsyncFunction("cancel") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      if (jobId.isBlank()) return@AsyncFunction
      // Best-effort: cancel in all active engines.
      enginesByAssetsDir.values.forEach { handle ->
        if (handle != 0L) {
          HappierSherpaNativeJni.nativeCancel(handle, jobId)
        }
      }
      HappierSherpaNativeJni.nativeCancelStreaming(jobId)
    }

    AsyncFunction("createStreamingRecognizer") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      val assetsDir = params["assetsDir"] as? String ?: ""
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16000
      val channels = (params["channels"] as? Number)?.toInt() ?: 1
      val language = params["language"] as? String

      if (jobId.isBlank()) throw Exception("jobId is required")
      if (assetsDir.isBlank()) throw Exception("assetsDir is required")

      val ok = HappierSherpaNativeJni.nativeCreateStreamingRecognizer(jobId, assetsDir, sampleRate, channels, language ?: "")
      if (ok != 1) {
        throw Exception("Failed to initialize sherpa streaming ASR (assets may be missing)")
      }
    }

    AsyncFunction("pushAudioFrame") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      val pcm16leBase64 = params["pcm16leBase64"] as? String ?: ""
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16000
      val channels = (params["channels"] as? Number)?.toInt() ?: 1

      if (jobId.isBlank()) throw Exception("jobId is required")

      val bytes = if (pcm16leBase64.isBlank()) ByteArray(0) else Base64.decode(pcm16leBase64, Base64.DEFAULT)
      return@AsyncFunction HappierSherpaNativeJni.nativePushAudioFrame(jobId, bytes, sampleRate, channels)
        ?: throw Exception("ASR stream not found")
    }

    AsyncFunction("finishStreaming") { params: Map<String, Any?> ->
      val jobId = params["jobId"] as? String ?: ""
      if (jobId.isBlank()) throw Exception("jobId is required")
      val text = HappierSherpaNativeJni.nativeFinishStreaming(jobId)
      return@AsyncFunction mapOf("text" to text)
    }

    AsyncFunction("releaseStreamingAssetsDir") { params: Map<String, Any?> ->
      val assetsDir = params["assetsDir"] as? String ?: ""
      if (assetsDir.isBlank()) throw Exception("assetsDir is required")
      val cancelledJobs = HappierSherpaNativeJni.nativeReleaseStreamingAssetsDir(assetsDir)
      return@AsyncFunction mapOf<String, Any>("cancelledJobs" to cancelledJobs)
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

  external fun nativeCreateEngine(assetsDir: String): Long
  external fun nativeDestroyEngine(handle: Long)
  external fun nativeGetSampleRate(handle: Long): Int
  external fun nativeGetNumSpeakers(handle: Long): Int
  external fun nativeSynthesizeToWavFile(handle: Long, text: String, sid: Int, speed: Float, outWavPath: String, jobId: String): Int
  external fun nativeCancel(handle: Long, jobId: String)

  external fun nativeCreateStreamingRecognizer(jobId: String, assetsDir: String, sampleRate: Int, channels: Int, language: String): Int
  external fun nativePushAudioFrame(jobId: String, pcm16le: ByteArray, sampleRate: Int, channels: Int): Map<String, Any?>?
  external fun nativeFinishStreaming(jobId: String): String
  external fun nativeCancelStreaming(jobId: String)
  external fun nativeReleaseStreamingAssetsDir(assetsDir: String): Int
  external fun nativeReleaseAllStreaming(): Int

  external fun nativeCreateVadSession(modelPath: String, sampleRate: Int, minSpeechSec: Float, minSilenceSec: Float): Long
  external fun nativeVadAcceptPcm16(handle: Long, pcm16: ShortArray, count: Int, channels: Int): Int
  external fun nativeDestroyVadSession(handle: Long)
}
