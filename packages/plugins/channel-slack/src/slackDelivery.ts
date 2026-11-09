import type { ConversationDeliveryLinkPreviewPolicyV1 } from '@happier-dev/channels-protocol/v1';

// Slack truncates text above 40,000 characters. Core owns splitting against
// this provider-declared ceiling.
// https://docs.slack.dev/reference/methods/chat.postMessage/ (2026-10-20)
export const SLACK_MAX_MESSAGE_CODE_POINTS = 40_000;

export type SlackMessagePayload = Readonly<{
  channel: string; text: string; thread_ts?: string; mrkdwn: false; parse: 'none'; link_names: false;
  unfurl_links: boolean; unfurl_media: boolean;
}>;

export function createSlackMessagePayload(input: Readonly<{
  channelId: string; text: string; threadTs?: string; linkPreviewPolicy: ConversationDeliveryLinkPreviewPolicyV1;
}>): SlackMessagePayload {
  // Explicit Slack references still carry notification semantics when automatic
  // parsing is disabled. Replace only their opening delimiter, preserving the
  // core's code-point budget instead of expanding text with HTML entities.
  const text = input.text.replace(/<(?=[@!#])/g, '‹');
  const unfurl = input.linkPreviewPolicy === 'providerDefault';
  return {
    channel: input.channelId,
    text,
    ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
    mrkdwn: false,
    parse: 'none',
    link_names: false,
    unfurl_links: unfurl,
    unfurl_media: unfurl,
  };
}
