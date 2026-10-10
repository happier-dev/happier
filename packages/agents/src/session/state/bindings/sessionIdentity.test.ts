import { describe, expect, it } from 'vitest';
import { readSessionStateFieldFromMetadata, writeSessionStateFieldToMetadata } from './publishField.js';

describe('registered Bot identity', () => {
  it('promotes and demotes the same Session without changing its existing work or creation fact', () => {
    const metadata = { createdAsBot: true as const, path: '/project', machineId: 'machine',
      summary: { text: 'Name', updatedAt: 12 }, sessionInitialPromptV1: 'Original remit',
      work: { sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Instructions' } } };
    const promoted = writeSessionStateFieldToMetadata(metadata, 'display.bot', { kind: 'bot' });
    expect(readSessionStateFieldFromMetadata(promoted, 'display.bot')).toEqual({ kind: 'bot' });
    expect(promoted).toMatchObject(metadata);
    const demoted = writeSessionStateFieldToMetadata(promoted, 'display.bot', null);
    expect(demoted).not.toHaveProperty('bot');
    expect(demoted).toMatchObject(metadata);
  });

  it('preserves an explicit memory choice and materializes the pre-change baseline for retained Sessions', () => {
    const promoted = writeSessionStateFieldToMetadata({}, 'display.bot', { kind: 'bot' });
    expect(promoted).toMatchObject({ bot: { kind: 'bot' }, work: { memoryEnabled: false } });
    const demoted = writeSessionStateFieldToMetadata({ bot: { kind: 'bot' } }, 'display.bot', null);
    expect(demoted).toEqual({ work: { memoryEnabled: true } });
    expect(writeSessionStateFieldToMetadata({ work: { memoryEnabled: true } }, 'display.bot', { kind: 'bot' }))
      .toMatchObject({ work: { memoryEnabled: true } });
    expect(writeSessionStateFieldToMetadata({ bot: { kind: 'bot' }, work: { memoryEnabled: false } }, 'display.bot', null))
      .toEqual({ work: { memoryEnabled: false } });
  });
});
