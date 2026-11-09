import { describe, expect, it } from 'vitest';
import { createSlackMessagePayload } from './slackDelivery.js';

describe('Slack plain-text delivery', () => {
  it('neutralizes explicit and automatic mentions while preserving thread and preview policy', () => {
    expect(createSlackMessagePayload({
      channelId: 'C1', threadTs: '123.456',
      text: '<@U1> <!here> <!channel> <!everyone> <!subteam^S1> <#C1> & @everyone *plain* x < 3 > 1',
      linkPreviewPolicy: 'suppress',
    })).toEqual({
      channel: 'C1', thread_ts: '123.456',
      text: '‹@U1> ‹!here> ‹!channel> ‹!everyone> ‹!subteam^S1> ‹#C1> & @everyone *plain* x < 3 > 1',
      mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false,
    });
    expect(createSlackMessagePayload({ channelId: 'C1', text: 'https://example.org', linkPreviewPolicy: 'providerDefault' }))
      .toMatchObject({ unfurl_links: true, unfurl_media: true });
  });

  it('preserves the native Unicode budget while neutralizing mentions', () => {
    expect(createSlackMessagePayload({ channelId: 'C1', text: '😀'.repeat(40_000), linkPreviewPolicy: 'suppress' }).text)
      .toBe('😀'.repeat(40_000));
    const text = `${'<@U1>'.repeat(7_999)} &<>!`;
    expect(Array.from(text)).toHaveLength(40_000);
    const encoded = createSlackMessagePayload({ channelId: 'C1', text, linkPreviewPolicy: 'suppress' }).text;
    expect(Array.from(encoded)).toHaveLength(40_000);
    expect(encoded).not.toContain('<@');
    // Core consumes the declared native ceiling; payload encoding must not
    // introduce a second size admission or silently truncate valid text.
    const aboveNative = 'x'.repeat(40_001);
    expect(createSlackMessagePayload({ channelId: 'C1', text: aboveNative, linkPreviewPolicy: 'suppress' }).text)
      .toBe(aboveNative);
  });
});
