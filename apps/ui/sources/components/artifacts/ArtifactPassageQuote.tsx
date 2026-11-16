import * as React from 'react';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';

import { ReplyQuote } from '@/components/ui/text/ReplyQuote';
import { t } from '@/text';

/** The passage is opened by the existing Doc/Discussion owner before reaching presentation; pressing it opens the Doc there. */
export function ArtifactPassageQuote(props: Readonly<{ testID?: string; passage: DocPassageRefV1 | null; onOpen?: (passage: DocPassageRefV1) => void }>) {
    const passage = props.passage;
    const onOpen = props.onOpen;
    return <ReplyQuote testID={props.testID} kind="doc_passage" source={passage
        ? { state: 'available', label: t('session.collaboration.discussion.quote.document'), text: passage.quote,
            detail: t('session.collaboration.discussion.quote.revision', passage.revision),
            ...(onOpen ? { onPress: () => onOpen(passage) } : {}) }
        : { state: 'unavailable', label: t('session.collaboration.discussion.quote.document'),
            reason: t('session.collaboration.discussion.quote.unavailable') }} />;
}
