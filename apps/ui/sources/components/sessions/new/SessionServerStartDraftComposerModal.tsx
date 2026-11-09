import * as React from 'react';
import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { CustomModalInjectedProps } from '@/modal';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { PopoverAnchor } from '@/components/ui/popover';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import type { SessionServerStartDraftSeed, SessionServerStartDraftTarget } from './serverStartDraftComposer';
import { useSessionServerStartDraftRecipe } from './useSessionServerStartDraftRecipe';
import { SessionServerStartDraftComposerBody } from './SessionServerStartDraftComposerBody';

type Props = CustomModalInjectedProps & Readonly<{
    anchor?: PopoverAnchor;
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
    onResolve: (draft: SessionServerStartSpawnDraftV1 | null) => void;
}>;

/** Returning recipe selector; inline hosts use its model and body without modal chrome. */
export function SessionServerStartDraftComposerModal(props: Props): React.ReactElement {
    const model = useSessionServerStartDraftRecipe(props);
    const dismiss = React.useCallback(() => { props.onResolve(null); props.onClose(); }, [props]);
    const submit = React.useCallback(() => {
        const draft = model.resolveDraft();
        if (!draft) return;
        props.onResolve(draft);
        props.onClose();
    }, [model.resolveDraft, props]);
    const footer = React.useMemo(() => (
        <ModalCardFooterActions cancel={{ onPress: dismiss }} note={t('agentStart.selector.nothingStarts')}>
            <RoundButton title={t('newSession.recipeComposerSubmit')} onPress={submit} disabled={!model.canSubmit} />
        </ModalCardFooterActions>
    ), [model.canSubmit, dismiss, submit]);
    useModalCardChrome(props.setChrome, {
        ...createAnchoredSheetChrome({ title: t('newSession.recipeComposerTitle'), anchor: props.anchor }),
        footer,
    });
    return <SessionServerStartDraftComposerBody seed={props.seed} model={model} />;
}
