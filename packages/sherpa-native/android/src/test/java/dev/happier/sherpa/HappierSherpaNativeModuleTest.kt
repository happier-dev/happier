package dev.happier.sherpa

import org.junit.Assert.assertEquals
import org.junit.Test

class HappierSherpaNativeModuleTest {
  @Test
  fun handleModuleDestroy_releasesStreamingAsrState() {
    var releaseCount = 0
    val module = HappierSherpaNativeModule(releaseAllStreaming = { releaseCount += 1 })

    module.handleModuleDestroy()

    assertEquals(1, releaseCount)
  }

  @Test
  fun handleModuleDestroy_cancelsExistingVadRegistry() {
    val registry = FakeVadDetectorRegistryControl()
    val module = HappierSherpaNativeModule(createVadRegistry = { registry }, releaseAllStreaming = {})

    module.getOrCreateVadRegistry()
    module.handleModuleDestroy()

    assertEquals(1, registry.cancelAllCallCount)
  }

  @Test
  fun handleModuleDestroy_doesNotCreateVadRegistryWhenNeverStarted() {
    var createCount = 0
    val module = HappierSherpaNativeModule(
      createVadRegistry = {
        createCount += 1
        FakeVadDetectorRegistryControl()
      },
      releaseAllStreaming = {}
    )

    module.handleModuleDestroy()

    assertEquals(0, createCount)
  }
}

private class FakeVadDetectorRegistryControl : FrameFedVadDetectorRegistryControl {
  var cancelAllCallCount: Int = 0

  override fun create(detectorId: String, sampleRate: Int, minSpeechMs: Long, redemptionMs: Long) = Unit

  override fun push(detectorId: String, pcm16: ShortArray, sampleRate: Int, channels: Int) =
    FrameFedVadFrameResult(false, false)

  override fun cancel(detectorId: String) = Unit

  override fun cancelAll() {
    cancelAllCallCount += 1
  }
}
