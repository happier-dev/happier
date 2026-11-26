import { beforeEach, describe, expect, it, vi } from 'vitest';

const alert = vi.hoisted(() => vi.fn());
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      spies: { alert },
    }).module,
);

const { t } = await import('@/text');
const { presentRecordingStartRefusal, presentRecordingStopOutcome } =
  await import('./recordingActions');

/** The alert's title, body and the buttons it offers (none given means the alert's own OK). */
function shown() {
  expect(alert).toHaveBeenCalledTimes(1);
  const [title, body, buttons] = alert.mock.calls[0] ?? [];
  return { title, body, buttons };
}

describe('recording failure presentation', () => {
  beforeEach(() => alert.mockReset());

  it('reveals the stopped capture cause through Technical details without inventing a request id', () => {
    presentRecordingStopOutcome({ status: 'failed', reason: 'capture_failed' });
    const details = shown().buttons?.find((button: { text: string }) => button.text === t('approvals.technicalDetails'));
    expect(details).toBeDefined();
    alert.mockReset();
    details?.onPress();
    expect(shown().body).toContain('capture_failed');
    expect(shown().body).not.toContain('requestId');
  });

  // The daemon's START admission (sessionMediaHost admitSave): nothing was captured in either case.
  it.each([
    ['recording_session_not_owned', 'browserRecording.failure.sessionNotOwned'],
    [
      'recording_session_unavailable',
      'browserRecording.failure.sessionUnavailable',
    ],
  ] as const)(
    'reads a START refusal as its cause (%s), with OK only',
    (code, key) => {
      presentRecordingStartRefusal(code);
      expect(shown()).toEqual({
        title: t('browserRecording.failure.startTitle'),
        body: t(key),
        buttons: undefined,
      });
    },
  );

  // STOP after capture: the capture stopped; the result names the file's fate (protocol recording/results.ts).
  it.each([
    ['workspace_write_failed', 'browserRecording.failure.notSavedGone'],
    ['transcript_attach_failed', 'browserRecording.failure.notSavedInFiles'],
    [undefined, 'browserRecording.failure.notSavedBody'],
    ['a_future_cause', 'browserRecording.failure.notSavedBody'],
  ] as const)(
    'says a stopped capture that was not saved stopped (saveFailure %s), never that it may still record',
    (saveFailure, key) => {
      presentRecordingStopOutcome({
        status: 'failed',
        reason: 'media_persistence_failed',
        ...(saveFailure ? { saveFailure } : {}),
      });
      const { title, body, buttons } = shown();
      expect({ title, body, buttons }).toEqual({
        // A recording kept in the Session's files was saved: only its place in the conversation is missing.
        title: t(saveFailure === 'transcript_attach_failed' ? 'browserRecording.failure.notInConversationTitle' : 'browserRecording.failure.notSavedTitle'),
        body: t(key),
        buttons: expect.any(Array),
      });
      expect(body).not.toBe(t('browserRecording.failure.stopBody'));
    },
  );

  it('stays quiet when the stop saved the recording', () => {
    presentRecordingStopOutcome({ status: 'finalized' });
    expect(alert).not.toHaveBeenCalled();
  });

  it('keeps "may still be recording" when the stop got no answer', () => {
    presentRecordingStopOutcome(null);
    expect(shown()).toEqual({
      title: t('browserRecording.failure.stopTitle'),
      body: t('browserRecording.failure.stopBody'),
      buttons: undefined,
    });
  });
});
