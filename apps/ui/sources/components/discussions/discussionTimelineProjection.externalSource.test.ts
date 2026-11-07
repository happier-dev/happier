import { expect, it } from 'vitest';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';

import { readDiscussionExternalSource, resolveDiscussionMessageSpeakerLabel } from './discussionTimelineProjection';
import { t } from '@/text';

it('attributes Via to the sealed conversation name, independently of its provider and binding correlation', () => {
    const content = DiscussionMessageContentV1Schema.parse({ v: 1,
        parts: [{ t: 'text', text: 'Can you check the invoice?' }],
        externalSource: { kind: 'channel', providerPluginId: 'happier.channel.email',
            conversationDisplayName: 'Acme billing', senderDisplayName: 'Jordan from Acme',
            inputLocalId: 'channels:36:33b93241-9b0f-4b9e-81bf-437e6884276a:delivery-1' },
    });
    const message = { authorAccountId: 'owner', accountActor: null, createdAt: 1, producerV1: null, content };
    const source = readDiscussionExternalSource(message);
    expect(source?.conversationDisplayName).toBe('Acme billing');
    expect(t('session.collaboration.discussion.viaExternal', { conversation: source!.conversationDisplayName }))
        .toBe('Via Acme billing');
    expect(resolveDiscussionMessageSpeakerLabel(message, { account: () => 'Maya Chen',
        session: () => null, workflowRun: () => null })).toBe('Jordan from Acme');
});
