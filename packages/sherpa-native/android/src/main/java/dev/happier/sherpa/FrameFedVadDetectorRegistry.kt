package dev.happier.sherpa

import android.content.Context
import dev.happier.sherpa.vad.VadModelAssetInstaller

internal data class FrameFedVadFrameResult(
  val speechStarted: Boolean,
  val speechEnded: Boolean
)

internal interface NativeVadDriver {
  fun create(modelPath: String, sampleRate: Int, minSpeechSec: Float, minSilenceSec: Float): Long
  fun push(handle: Long, pcm16: ShortArray, channels: Int): Int
  fun destroy(handle: Long)
}

private object JniNativeVadDriver : NativeVadDriver {
  override fun create(modelPath: String, sampleRate: Int, minSpeechSec: Float, minSilenceSec: Float): Long =
    HappierSherpaNativeJni.nativeCreateVadSession(modelPath, sampleRate, minSpeechSec, minSilenceSec)

  override fun push(handle: Long, pcm16: ShortArray, channels: Int): Int =
    HappierSherpaNativeJni.nativeVadAcceptPcm16(handle, pcm16, pcm16.size, channels)

  override fun destroy(handle: Long) {
    HappierSherpaNativeJni.nativeDestroyVadSession(handle)
  }
}

internal interface FrameFedVadDetectorRegistryControl {
  fun create(detectorId: String, sampleRate: Int, minSpeechMs: Long, redemptionMs: Long)
  fun push(detectorId: String, pcm16: ShortArray, sampleRate: Int, channels: Int): FrameFedVadFrameResult
  fun cancel(detectorId: String)
  fun cancelAll()
}

/** Inference-only VAD ownership. It never opens AudioRecord or changes audio focus/session state. */
internal class FrameFedVadDetectorRegistry(
  context: Context? = null,
  private val driver: NativeVadDriver = JniNativeVadDriver,
  private val resolveModelPath: () -> String = {
    VadModelAssetInstaller.ensureInstalled(requireNotNull(context) { "Android context is required" })
  }
) : FrameFedVadDetectorRegistryControl {
  private data class Entry(
    val handle: Long,
    val sampleRate: Int,
    var speechActive: Boolean = false
  )

  private val entries = mutableMapOf<String, Entry>()

  @Synchronized
  override fun create(detectorId: String, sampleRate: Int, minSpeechMs: Long, redemptionMs: Long) {
    require(detectorId.isNotBlank()) { "detectorId is required" }
    require(sampleRate > 0) { "sampleRate must be positive" }

    val modelPath = resolveModelPath()
    val handle = driver.create(
      modelPath,
      sampleRate,
      (minSpeechMs.coerceAtLeast(0) / 1000.0).toFloat(),
      (redemptionMs.coerceAtLeast(0) / 1000.0).toFloat()
    )
    check(handle != 0L) { "failed_to_create_vad_detector" }

    entries.put(detectorId, Entry(handle, sampleRate))?.let { driver.destroy(it.handle) }
  }

  @Synchronized
  override fun push(
    detectorId: String,
    pcm16: ShortArray,
    sampleRate: Int,
    channels: Int
  ): FrameFedVadFrameResult {
    val entry = entries[detectorId] ?: throw IllegalStateException("vad_detector_not_found")
    require(sampleRate == entry.sampleRate) { "vad_sample_rate_mismatch" }
    require(channels > 0) { "channels must be positive" }

    val state = driver.push(entry.handle, pcm16, channels)
    val speechDetected = state and 1 != 0
    val speechEnded = state and 2 != 0
    val speechStarted = speechDetected && !entry.speechActive
    entry.speechActive = speechDetected && !speechEnded
    return FrameFedVadFrameResult(speechStarted, speechEnded)
  }

  @Synchronized
  override fun cancel(detectorId: String) {
    entries.remove(detectorId)?.let { driver.destroy(it.handle) }
  }

  @Synchronized
  override fun cancelAll() {
    val active = entries.values.toList()
    entries.clear()
    active.forEach { driver.destroy(it.handle) }
  }
}
