package dev.happier.sherpa

import org.junit.Assert.assertEquals
import org.junit.Test

class FrameFedVadDetectorRegistryTest {
  @Test
  fun push_emitsOneStartEdge_thenEnd_thenAllowsNextStart() {
    val driver = FakeNativeVadDriver(mutableListOf(1, 1, 2, 1))
    val registry = FrameFedVadDetectorRegistry(driver = driver, resolveModelPath = { "model.onnx" })
    registry.create("vad", 16_000, 0, 0)

    assertEquals(true, registry.push("vad", shortArrayOf(0), 16_000, 1).speechStarted)
    assertEquals(false, registry.push("vad", shortArrayOf(0), 16_000, 1).speechStarted)
    assertEquals(true, registry.push("vad", shortArrayOf(0), 16_000, 1).speechEnded)
    assertEquals(true, registry.push("vad", shortArrayOf(0), 16_000, 1).speechStarted)
  }

  @Test
  fun replacementAndCancel_destroyExactlyTheirOwnHandles() {
    val driver = FakeNativeVadDriver(mutableListOf())
    val registry = FrameFedVadDetectorRegistry(driver = driver, resolveModelPath = { "model.onnx" })
    registry.create("vad", 16_000, 0, 0)
    registry.create("vad", 16_000, 0, 0)
    registry.cancel("vad")
    registry.cancel("vad")

    assertEquals(listOf(1L, 2L), driver.destroyed)
  }
}

private class FakeNativeVadDriver(
  private val states: MutableList<Int>
) : NativeVadDriver {
  private var nextHandle = 1L
  val destroyed = mutableListOf<Long>()

  override fun create(modelPath: String, sampleRate: Int, minSpeechSec: Float, minSilenceSec: Float): Long = nextHandle++

  override fun push(handle: Long, pcm16: ShortArray, channels: Int): Int =
    if (states.isEmpty()) 0 else states.removeAt(0)

  override fun destroy(handle: Long) {
    destroyed += handle
  }
}
