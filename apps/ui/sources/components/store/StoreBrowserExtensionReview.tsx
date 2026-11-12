import * as React from 'react';
import type { BrowserExtensionPermissionReviewV1 } from '@happier-dev/protocol/browser/profile/extensionsV1';

import { PluginListingFacts } from '@/components/settings/plugins/listing/PluginListingFacts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

export type StoreBrowserExtensionReviewProps = Readonly<{
    review: BrowserExtensionPermissionReviewV1;
    restartRequired: boolean;
    confirmText: string;
    onDecision: (accepted: boolean) => void;
}>;

/** Browser packages use the Store's install review; the browser service remains the consent authority. */
export function StoreBrowserExtensionReview(props: StoreBrowserExtensionReviewProps & CustomModalInjectedProps) {
    const decide = React.useCallback((accepted: boolean) => {
        props.onDecision(accepted);
        props.onClose();
    }, [props.onDecision, props.onClose]);
    const footer = React.useMemo(() => <ModalCardFooterActions
        cancel={{ onPress: () => decide(false), testID: 'store.browserExtension.review.cancel' }}>
        <RoundButton title={props.confirmText} testID="store.browserExtension.review.confirm" onPress={() => decide(true)} />
    </ModalCardFooterActions>, [decide, props.confirmText]);
    const chrome = React.useMemo(() => ({ ...createAnchoredSheetChrome({
        title: t('capabilities.store.browserExtensionInstall.reviewTitle'), testID: 'store.browserExtension.review',
    }), footer }), [footer]);
    useModalCardChrome(props.setChrome, chrome);
    return <ItemList presentation="grouped">
        <PluginListingFacts browserExtension={props.review} testID="store.browserExtension.review.facts" />
        {props.restartRequired ? <ItemGroup><Item title={t('capabilities.store.browserExtensionInstall.restartBody')}
            mode="info" showChevron={false} /></ItemGroup> : null}
    </ItemList>;
}
