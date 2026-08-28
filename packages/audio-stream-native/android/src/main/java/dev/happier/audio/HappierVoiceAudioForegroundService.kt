package dev.happier.audio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Delivery component for the aggregate audio-session owner. It has no Voice
 * state or provider policy of its own: the module starts it only while the
 * owner has applied an input-enabled conversation configuration.
 */
internal class HappierVoiceAudioForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    val requestId = intent.getStringExtra(EXTRA_START_REQUEST_ID)
    try {
      ensureNotificationChannel()
      val notificationBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(this, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(this)
      }
      val notification = notificationBuilder
        .setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentTitle(applicationInfo.loadLabel(packageManager))
        .setContentText(getString(R.string.happier_voice_foreground_notification_text))
        .setCategory(Notification.CATEGORY_SERVICE)
        .setOngoing(true)
        .build()
      val foregroundServiceType = foregroundServiceTypeForSdk(Build.VERSION.SDK_INT)
      if (foregroundServiceType != null) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          foregroundServiceType,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      settleStart(requestId, Result.success(Unit))
    } catch (error: Throwable) {
      settleStart(requestId, Result.failure(error))
      stopSelf(startId)
      return START_NOT_STICKY
    }
    return START_NOT_STICKY
  }

  private fun ensureNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        getString(R.string.happier_voice_foreground_notification_channel),
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        setShowBadge(false)
      },
    )
  }

  companion object {
    private const val CHANNEL_ID = "happier_voice_conversation"
    private const val NOTIFICATION_ID = 42017
    private const val EXTRA_START_REQUEST_ID = "happier_voice_start_request_id"
    private val startLock = Any()
    private var pendingStart: Pair<String, (Result<Unit>) -> Unit>? = null

    fun start(context: Context, requestId: String, onStarted: (Result<Unit>) -> Unit) {
      synchronized(startLock) {
        check(pendingStart == null) { "foreground_service_start_pending" }
        pendingStart = requestId to onStarted
      }
      val intent = Intent(context, HappierVoiceAudioForegroundService::class.java)
        .putExtra(EXTRA_START_REQUEST_ID, requestId)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (error: Throwable) {
        settleStart(requestId, Result.failure(error))
      }
    }

    fun cancelPendingStart(requestId: String) {
      synchronized(startLock) {
        if (pendingStart?.first == requestId) pendingStart = null
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, HappierVoiceAudioForegroundService::class.java))
    }

    private fun settleStart(requestId: String?, result: Result<Unit>) {
      if (requestId == null) return
      val callback = synchronized(startLock) {
        val pending = pendingStart
        if (pending?.first != requestId) return@synchronized null
        pendingStart = null
        pending.second
      }
      callback?.invoke(result)
    }
  }
}

internal fun foregroundServiceTypeForSdk(sdkInt: Int): Int? = when {
  sdkInt >= Build.VERSION_CODES.Q ->
    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
  else -> null
}

/** The aggregate coordinator supplies this mode/input pair; Dictation is excluded. */
internal fun requiresVoiceForegroundService(mode: String, input: Boolean): Boolean =
  mode == "conversation" && input
