import type { VoiceAdapterId, VoiceSessionMode, VoiceSessionStatus } from '@/voice/session/types';

export type VoiceActivityEventBase = Readonly<{
  id: string;
  ts: number;
  sessionId: string;
  adapterId: VoiceAdapterId;
}>;

export type VoiceActivityActionId =
  | 'sendSessionMessage'
  | 'processPermissionRequest'
  | 'listExecutionRuns'
  | 'getExecutionRun'
  | 'sendExecutionRunMessage'
  | 'stopExecutionRun'
  | 'actionExecutionRun'
  | 'openSession'
  | 'spawnSession'
  | 'resetGlobalVoiceAgent'
  | 'unknown';

export type VoiceActivityEvent =
  | (VoiceActivityEventBase &
      Readonly<{
        kind: 'lifecycle.start' | 'lifecycle.stop';
      }>)
  | (VoiceActivityEventBase &
      Readonly<{
        kind: 'status';
        status: VoiceSessionStatus;
        mode: VoiceSessionMode;
      }>)
  | (VoiceActivityEventBase &
      Readonly<{
        kind: 'user.text' | 'assistant.text';
        text: string;
      }>)
  | (VoiceActivityEventBase &
      Readonly<{
        kind: 'assistant.delta';
        textDelta: string;
      }>)
  | (VoiceActivityEventBase &
      Readonly<{
        kind: 'action.executed';
        action: VoiceActivityActionId;
        summary: string;
      }>)
  | (VoiceActivityEventBase &
      Readonly<{
        kind: 'error';
        errorCode: string;
        errorMessage: string;
      }>);
