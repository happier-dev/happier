package dev.happier.audio

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class AudioRouteNameTest {
  @Test
  fun mapsCommunicationDeviceTypesToStableRouteNames() {
    assertEquals("bluetooth", routeNameForDeviceType(AudioDeviceInfo.TYPE_BLUETOOTH_SCO))
    assertEquals("wired", routeNameForDeviceType(AudioDeviceInfo.TYPE_WIRED_HEADSET))
    assertEquals("earpiece", routeNameForDeviceType(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE))
    assertEquals("speaker", routeNameForDeviceType(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER))
    assertEquals("unknown", routeNameForDeviceType(AudioDeviceInfo.TYPE_UNKNOWN))
  }
}
