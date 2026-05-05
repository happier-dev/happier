package dev.happier.sherpa

import org.junit.Assert.assertEquals
import org.junit.Test

class HappierSherpaNativeModuleTest {
  @Test
  fun handleModuleDestroy_stopsExistingVadRunner() {
    val runner = FakeVadSessionRunnerControl()
    val module = HappierSherpaNativeModule(createVadRunner = { runner })

    module.getOrCreateVadRunner()
    module.handleModuleDestroy()

    assertEquals(1, runner.stopAnyCallCount)
  }

  @Test
  fun handleModuleDestroy_doesNotCreateVadRunnerWhenNeverStarted() {
    var createCount = 0
    val module = HappierSherpaNativeModule(
      createVadRunner = {
        createCount += 1
        FakeVadSessionRunnerControl()
      }
    )

    module.handleModuleDestroy()

    assertEquals(0, createCount)
  }
}

private class FakeVadSessionRunnerControl : VadSessionRunnerControl {
  var stopAnyCallCount: Int = 0

  override fun startVadSession(sessionId: String, minSpeechMs: Long, redemptionMs: Long) = Unit

  override fun stopVadSession(sessionId: String) = Unit

  override fun stopAny() {
    stopAnyCallCount += 1
  }
}
