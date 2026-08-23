package dev.happier.sherpa

import kotlinx.coroutines.isActive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HappierSherpaNativeModuleTest {
  @Test
  fun handleModuleDestroy_releasesNativeEngineCaches() {
    var releaseCount = 0
    val module = HappierSherpaNativeModule(releaseAllNative = { releaseCount += 1 })

    module.handleModuleDestroy()

    assertEquals(1, releaseCount)
  }

  @Test
  fun handleModuleDestroy_stopsBothSherpaWorkers() {
    // The workers own dedicated threads, so teardown that forgets one leaks a
    // thread for the life of the process. (The release-before-shutdown ordering
    // that lets a blocked worker unwind is pinned in
    // `scripts/native-cancellation-scheduling.test.mjs`.)
    val module = HappierSherpaNativeModule(releaseAllNative = {})
    assertTrue(module.ttsWorker.scope.isActive)
    assertTrue(module.asrWorker.scope.isActive)

    module.handleModuleDestroy()

    assertFalse(module.ttsWorker.scope.isActive)
    assertFalse(module.asrWorker.scope.isActive)
  }

  @Test
  fun handleModuleDestroy_cancelsExistingVadRegistry() {
    val registry = FakeVadDetectorRegistryControl()
    val module = HappierSherpaNativeModule(createVadRegistry = { registry }, releaseAllNative = {})

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
      releaseAllNative = {}
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
