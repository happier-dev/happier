package dev.happier.quietmode

import android.app.NotificationManager
import android.content.Context
import android.media.AudioManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Sound effects play as media audio, which neither Do Not Disturb nor a silent or vibrate ringer
 * mutes. This reports whether either quiet mode is on so the app can stay silent itself.
 * Reading the interruption filter and ringer mode needs no permission.
 */
class HappierQuietModeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HappierQuietMode")

    Function("isQuietModeActive") {
      val context = appContext.reactContext ?: throw IllegalStateException("App context is unavailable")
      isQuietModeActive(context)
    }
  }

  /** Only "all interruptions" with a normal ringer may play; anything unreadable counts as quiet. */
  private fun isQuietModeActive(context: Context): Boolean {
    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      ?: return true
    if (notificationManager.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL) return true
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return true
    return audioManager.ringerMode != AudioManager.RINGER_MODE_NORMAL
  }
}
