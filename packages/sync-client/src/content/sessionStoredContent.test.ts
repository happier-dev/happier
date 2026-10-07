import { expect, it } from 'vitest';
import { openSessionStateValue, openSessionStoredContent, resolveSessionStoredContentEnvelope, sealSessionStoredContent } from './sessionStoredContent.js';

it('fails mismatched and malformed envelopes closed before using encryption', async () => {
  const encryption = { encryptRaw: async () => { throw new Error('wrong mode'); }, decryptRaw: async () => { throw new Error('wrong mode'); } };
  expect(await openSessionStoredContent({ mode: 'plain' }, { t: 'encrypted', c: 'sealed' })).toEqual({ status: 'mode_mismatch' });
  expect(await openSessionStoredContent({ mode: 'e2ee', encryption }, { t: 'plain', v: { text: 'private' } })).toEqual({ status: 'mode_mismatch' });
  expect(await openSessionStoredContent({ mode: 'e2ee', encryption: null }, { t: 'encrypted', c: 'sealed' })).toEqual({ status: 'locked' });
  expect(await sealSessionStoredContent({ mode: 'plain' }, { text: 'public' })).toEqual({ status: 'ready', content: { t: 'plain', v: { text: 'public' } } });
});
it('drops unknown stored envelope fields without dropping opaque content or changing its mode', async () => {
  const value = { futureToolArgument: { enabled: true } };
  const input = { t: 'plain', v: value, futureEnvelopeField: true };
  expect(resolveSessionStoredContentEnvelope({ mode: 'plain' }, input)).toEqual({ status: 'ready', content: { t: 'plain', v: value } });
  expect(await openSessionStoredContent({ mode: 'plain' }, input)).toEqual({ status: 'ready', value });
  expect(await openSessionStoredContent({ mode: 'e2ee', encryption: null }, input)).toEqual({ status: 'mode_mismatch' });
  expect(resolveSessionStoredContentEnvelope({ mode: 'e2ee' }, { t: 'encrypted', c: 'sealed', futureEnvelopeField: true })).toEqual({ status: 'ready', content: { t: 'encrypted', c: 'sealed' } });
});
it('opens raw plain session state and reports an unopenable encrypted state', async () => {
  expect(await openSessionStateValue({ mode: 'plain' }, '{"requests":{}}')).toEqual({ status: 'ready', value: { requests: {} } });
  expect(await openSessionStateValue({ mode: 'plain' }, 'sealed')).toEqual({ status: 'corrupt_or_unopenable' });
  expect(await openSessionStateValue({ mode: 'e2ee', encryption: { encryptRaw: async () => '', decryptRaw: async () => null } }, 'sealed')).toEqual({ status: 'corrupt_or_unopenable' });
});
it('rejects a plain envelope without its explicit value', async () => {
  expect(await openSessionStoredContent({ mode: 'plain' }, { t: 'plain' })).toEqual({ status: 'malformed' });
});
