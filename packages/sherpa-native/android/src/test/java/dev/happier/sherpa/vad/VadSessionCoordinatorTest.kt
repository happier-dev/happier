package dev.happier.sherpa.vad

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VadSessionCoordinatorTest {
  @Test
  fun startSession_stopsPreviousSessionEvenIfSameId() {
    val coord = VadSessionCoordinator()
    val stopped = mutableListOf<String>()

    coord.startSession("a") { stopped.add(it) }
    coord.startSession("a") { stopped.add(it) }

    assertEquals(listOf("a"), stopped)
  }

  @Test
  fun startSession_stopsPreviousSessionIfDifferentId() {
    val coord = VadSessionCoordinator()
    val stopped = mutableListOf<String>()

    coord.startSession("a") { stopped.add(it) }
    coord.startSession("b") { stopped.add(it) }

    assertEquals(listOf("a"), stopped)
  }

  @Test
  fun stopSession_onlyStopsWhenIdMatchesActive() {
    val coord = VadSessionCoordinator()
    val stopped = mutableListOf<String>()

    coord.startSession("a") { stopped.add(it) }
    coord.stopSession("b") { stopped.add(it) }
    coord.stopSession("a") { stopped.add(it) }

    assertEquals(listOf("a"), stopped)
  }

  @Test(expected = IllegalArgumentException::class)
  fun startSession_requiresSessionId() {
    val coord = VadSessionCoordinator()
    coord.startSession("") {}
  }

  @Test(expected = IllegalArgumentException::class)
  fun stopSession_requiresSessionId() {
    val coord = VadSessionCoordinator()
    coord.stopSession("") {}
  }
}
