import { t } from '@/text';

import type { UnsupportedContentKind } from './unsupportedContentMeta';

export function resolveUnsupportedContentLabel(kind: UnsupportedContentKind): string {
    switch (kind) {
        case 'unparsed-user-message':
            return t('transcript.unsupportedContent.unparsedUserMessage');
        case 'unparsed-agent-message':
            return t('transcript.unsupportedContent.unparsedAgentMessage');
        case 'unsupported-agent-output':
            return t('transcript.unsupportedContent.unsupportedAgentOutput');
        case 'unsupported-transcript-record':
            return t('transcript.unsupportedContent.unsupportedTranscriptRecord');
    }
}
