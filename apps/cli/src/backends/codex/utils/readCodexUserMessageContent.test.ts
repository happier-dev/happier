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

  it('does not silently accept unsupported future content', () => {
    expect(() => projectCodexNativeHistoryItem({ type: 'userMessage', id: 'user-2', content: [{ type: 'future' }] })).toThrow();
  });
});
