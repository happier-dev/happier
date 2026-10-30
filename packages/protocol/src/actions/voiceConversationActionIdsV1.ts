
/** Action identity leaf: schema modules and the registry share these constants. */
export const VOICE_CONVERSATION_ACTION_IDS = [
  'ui.voice_global.say.start', 'ui.voice_global.say.stop',
  'ui.voice_global.get', 'ui.voice_global.start', 'ui.voice_global.end', 'ui.voice_global.set_muted',
  'ui.voice_global.new_conversation', 'ui.voice_global.continue_conversation',
  'ui.voice_global.conversations.list', 'ui.voice_global.conversations.open',
  'ui.voice_global.recover', 'ui.voice_global.dismiss', 'ui.voice_global.turn_control',
  'ui.voice_global.hold_begin', 'ui.voice_global.hold_release', 'ui.voice_global.hold_cancel',
  'ui.voice_global.brief.request', 'ui.voice_global.brief.retry', 'ui.voice_global.brief.stop',
  'ui.voice_global.brief.close', 'ui.voice_global.glance.open', 'ui.voice_global.glance.close',
  'ui.voice_global.transcript.set_visible', 'ui.voice_global.companion.reveal', 'ui.voice_global.position.set',
  'ui.voice_global.setup.open', 'ui.voice_global.setup.close', 'ui.voice_global.open_conversation',
  'ui.voice_global.setup.microphone.permission.request', 'ui.voice_global.setup.system_settings.open',
  'ui.voice_global.dictation.start', 'ui.voice_global.dictation.finish',
  'ui.voice_global.dictation.cancel', 'ui.voice_global.dictation.dismiss',
  'ui.voice_global.dictation.retry',
  'ui.voice_global.history.search', 'ui.voice_global.history.load_older',
  'ui.voice_global.history.export', 'ui.voice_global.history.clear',
] as const;
