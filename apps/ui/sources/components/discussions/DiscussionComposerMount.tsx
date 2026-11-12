import * as React from 'react';
import type { ComposerRefV1, ComposerSnapshotV1, ComposerTransactionResultV1 } from '@happier-dev/protocol/plugins/ui/composer';

import type { AgentInput } from '@/components/sessions/agentInput';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';
import {
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
} from '@/components/sessions/composer/composerScopeAdapters';
import {
    notifyComposerPresentationTargetChanged,
    registerComposerPresentationTarget,
    useStableComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useComposerPresentationInputEffects } from '@/components/sessions/presentation/useComposerPresentationInputEffects';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { parseComposerStructuredInputMentionsForText } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

type InputBinding = Pick<React.ComponentProps<typeof AgentInput>,
    'composerRef' | 'composerDecorations' | 'composerInputLock' | 'onComposerFocusRequestChange' | 'onComposerActionBarLayoutChange'>;

/** A mounted adapter over the existing controlled Discussion draft, never another draft store. */
export function DiscussionComposerMount(props: Readonly<{
    composer: Extract<ComposerRefV1, { kind: 'discussion' }> | null;
    scope: ServerAccountScope;
    lifetime: ServerAccountScopeLifetime;
    available: boolean;
    disabled: boolean;
    readDocument(): Readonly<{ revision: number; text: string; mentions: readonly ComposerStructuredInputMention[] }>;
    writeDocument(value: Readonly<{ text: string; mentions: readonly ComposerStructuredInputMention[] }>): void;
    children(binding: InputBinding, onFocusChange: (focused: boolean) => void): React.ReactElement;
}>): React.ReactElement {
    const mounted = React.useRef(false);
    const focused = React.useRef(false);
    const focusRequest = React.useRef<(() => void) | null>(null);
    const layout = React.useRef<ComposerSnapshotV1['layout']>('wrap');
    const effects = useComposerPresentationInputEffects({ ref: props.composer });
    const current = React.useCallback(() => props.composer !== null && mounted.current && props.available && props.lifetime.isCurrent()
        && areServerAccountScopesEqual(props.scope, props.lifetime.scope), [props.composer, props.available, props.lifetime, props.scope]);
    const readSnapshot = (): ComposerSnapshotV1 => {
        const document = props.readDocument();
        const lock = effects.readComposerInputLock();
        return {
            revision: document.revision, ref: props.composer!, text: document.text,
            references: [...composerReferencesFromStructuredMentions({ text: document.text, mentions: document.mentions })],
            attachments: [], layout: layout.current,
            // This bit admits structured plugin attachment transactions. The ordinary file
            // tray is separate; this adapter cannot yet commit plugin attachment records.
            capabilities: { text: true, references: true, attachments: false, submit: true },
            state: { focused: focused.current, editable: !props.disabled && lock?.mode !== 'editAndSubmit',
                submittable: !props.disabled && document.text.trim().length > 0 && lock === null,
                submitting: false, running: false, ...(lock ? { inputLock: lock } : {}) },
        };
    };
    const commitDocument = (input: Readonly<{
        expectedRevision: number; mutation: ComposerPresentationDocumentMutation;
    }>): ComposerTransactionResultV1 => {
        if (!current()) return { status: 'composerUnavailable' };
        const document = props.readDocument();
        if (input.expectedRevision !== document.revision) return { status: 'conflict', currentRevision: document.revision };
        const mentions = composerStructuredMentionsFromReferences({ references: input.mutation.references, existing: document.mentions });
        // The shared document owner retains typed references. Only the closed
        // Discussion participant projection can give them addressing meaning on Send.
        const parsed = parseComposerStructuredInputMentionsForText(mentions, input.mutation.text);
        if (!parsed.fullyDecoded || parsed.mentions.length !== input.mutation.references.length
            || input.mutation.attachments.length > 0) {
            return { status: 'invalidOperation', operationIndex: 0, reason: 'unsupportedField' };
        }
        props.writeDocument({ text: input.mutation.text, mentions });
        return { status: 'applied', revision: props.readDocument().revision };
    };
    const target = useStableComposerPresentationTarget(props.composer, {
        readScope: () => props.scope, isCurrent: current, readSnapshot,
        readRevision: () => props.readDocument().revision,
        replace: (text, expectedRevision) => {
            const result = commitDocument({ expectedRevision, mutation: { text, references: [], attachments: [] } });
            return result.status === 'applied' ? result.revision : props.readDocument().revision;
        },
        commitDocument,
        setComposerDecorations: effects.setComposerDecorations,
        acquireComposerInputLock: effects.acquireComposerInputLock,
        focusComposer: () => {
            if (!current() || props.disabled || effects.readComposerInputLock()?.mode === 'editAndSubmit' || !focusRequest.current) return false;
            focusRequest.current();
            return true;
        },
    });
    React.useLayoutEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    React.useEffect(() => props.composer ? registerComposerPresentationTarget(props.composer, target) : undefined, [props.composer, target]);
    React.useEffect(() => {
        const registration = props.lifetime.onRetire(() => {
            effects.retire();
            if (props.composer) notifyComposerPresentationTargetChanged(props.composer);
        });
        return () => registration.dispose();
    }, [effects.retire, props.composer, props.lifetime]);
    const revision = props.readDocument().revision;
    React.useEffect(() => { if (props.composer) notifyComposerPresentationTargetChanged(props.composer); }, [props.composer, props.disabled, props.available, revision]);
    const onFocusChange = React.useCallback((value: boolean) => {
        focused.current = value;
        if (props.composer) notifyComposerPresentationTargetChanged(props.composer);
    }, [props.composer]);
    const onFocusRequestChange = React.useCallback((request: (() => void) | null) => { focusRequest.current = request; }, []);
    const onLayoutChange = React.useCallback((value: ComposerSnapshotV1['layout']) => {
        layout.current = value;
        if (props.composer) notifyComposerPresentationTargetChanged(props.composer);
    }, [props.composer]);
    return props.children({ composerRef: props.composer ?? undefined, composerDecorations: effects.composerDecorations,
        composerInputLock: effects.composerInputLock, onComposerFocusRequestChange: onFocusRequestChange,
        onComposerActionBarLayoutChange: onLayoutChange }, onFocusChange);
}
