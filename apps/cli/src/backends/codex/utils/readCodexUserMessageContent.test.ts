import { describe, expect, it } from 'vitest';
import { projectCodexNativeHistoryItem } from '../appServer/session/projectCodexNativeHistoryItem';
import { projectCodexRolloutActions } from '../rollout/projectCodexRolloutActions';
import { mapCodexProjectedEventsToDirectMessages } from '../directSessions/mapCodexRolloutLineToDirectMessages';
import { readCodexUserMessageContent } from './readCodexUserMessageContent';

describe('native Codex user content preservation', () => {
  it('preserves native mentions, local image references and text annotations', () => {
    const content = [
      { type: 'text', text: 'See README', text_elements: [{ byte_range: { start: 4, end: 10 }, placeholder: 'README' }] },
      { type: 'mention', name: 'README.md', path: '/repo/README.md' },
      { type: 'localImage', path: '/repo/image.png' },
    ];
    const result = readCodexUserMessageContent(content);
    expect(result?.nativeContent).toEqual(content);
    expect(result?.text).toContain('/repo/README.md');
    expect(result?.text).toContain('/repo/image.png');
    expect(readCodexUserMessageContent([content[0]])?.nativeContent).toEqual([content[0]]);
  });
  it('retains skill references and image bytes through the direct transcript projection', () => {
    const content = [
      { type: 'text', text: 'Inspect this', text_elements: [] },
      { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
      { type: 'image', url: 'data:image/png;base64,cHJpdmF0ZQ==', detail: 'original' },
    ];
    const actions = projectCodexNativeHistoryItem({ type: 'userMessage', id: 'user-1', content });
    const messages = mapCodexProjectedEventsToDirectMessages({
      projected: projectCodexRolloutActions(actions, { sidechainId: null }),
      createdAtMs: 1, idForIndex: index => String(index),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.raw).toMatchObject({ role: 'user', meta: { codexNativeContent: content } });
    expect(messages[0]?.raw.content).toMatchObject({ text: expect.stringContaining('/skills/review/SKILL.md') });
    expect(JSON.stringify(messages[0]?.raw.content)).not.toContain('cHJpdmF0ZQ==');
    expect(messages[0]?.raw.content).toMatchObject({ text: expect.stringContaining('preview unavailable') });
  });

  it('accepts the camelCase text annotation field emitted by the app-server protocol', () => {
    const content = [{
      type: 'text',
      text: 'See README',
      textElements: [{ byteRange: { start: 4, end: 10 }, placeholder: 'README' }],
    }];
    expect(readCodexUserMessageContent(content)?.nativeContent).toEqual(content);
  });

  it('does not silently accept unsupported future content', () => {
    expect(() => projectCodexNativeHistoryItem({ type: 'userMessage', id: 'user-2', content: [{ type: 'future' }] }))
      .toThrow(/projection.*user content.*future/);
    expect(() => projectCodexNativeHistoryItem({ type: 'future', id: 'item-1' }))
      .toThrow(/projection.*transcript item.*future/);
  });

  it.each([
    { type: 'image', fileId: 'file-image' },
    { type: 'audio', url: 'data:audio/wav;base64,cHJpdmF0ZQ==' },
    { type: 'audio', fileId: 'file-audio' },
    { type: 'localAudio', path: '/repo/recording.wav' },
  ])('retains Codex 0.167 $type media without putting inline bytes in display text', part => {
    const content = [{ type: 'text', text: 'Inspect this' }, part];
    const actions = projectCodexNativeHistoryItem({ type: 'userMessage', id: 'media', content });
    const messages = mapCodexProjectedEventsToDirectMessages({
      projected: projectCodexRolloutActions(actions, { sidechainId: null }),
      createdAtMs: 1, idForIndex: index => String(index),
    });
    expect(messages[0]?.raw).toMatchObject({ meta: { codexNativeContent: content } });
    expect(messages[0]?.raw.content).toMatchObject({ text: expect.stringContaining('unavailable') });
    expect(JSON.stringify(messages[0]?.raw.content)).not.toContain('cHJpdmF0ZQ==');
  });

  it('does not expose content or malformed type strings in projection diagnostics', () => {
    for (const type of ['private\ncontent', 'file:///private/history']) {
      for (const item of [
        { type, id: 'bad', text: 'private payload' },
        { type: 'userMessage', id: 'bad', content: [{ type, text: 'private payload' }] },
      ]) {
        try {
          projectCodexNativeHistoryItem(item);
          expect.fail('unsupported content must fail');
        } catch (error) {
          expect(String(error)).toContain('unknown');
          expect(String(error)).not.toContain(type);
          expect(String(error)).not.toContain('private payload');
        }
      }
    }
  });
});
