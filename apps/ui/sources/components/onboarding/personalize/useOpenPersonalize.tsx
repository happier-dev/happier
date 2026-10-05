import * as React from 'react';
import { View } from 'react-native';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useOptionalWorkspaceNavigation } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import type { PersonalizePageId } from './personalizeFlowModel';

const LazyPersonalizeFlowSheet = React.lazy(async () => {
    const module = await import('./PersonalizeFlowView');
    return { default: module.PersonalizeFlowSheet };
});

/** The page Personalize Happier opens on a computer: a workspace destination of its own, beside Home. */
export const PERSONALIZE_ROUTE = '/personalize';
export const PERSONALIZE_PAGE_PARAM = 'page';

export function buildPersonalizeHref(page?: PersonalizePageId): string {
    return page ? `${PERSONALIZE_ROUTE}?${PERSONALIZE_PAGE_PARAM}=${page}` : PERSONALIZE_ROUTE;
}

/** The phone's full-height sheet: the flow fills the shared modal's bottom sheet. */
function PersonalizeSheetModal(props: CustomModalInjectedProps & Readonly<{ initialPage?: PersonalizePageId }>) {
    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <React.Suspense fallback={<View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivitySpinner /></View>}>
                <LazyPersonalizeFlowSheet initialPage={props.initialPage} onClose={props.onClose} />
            </React.Suspense>
        </View>
    );
}

/**
 * Opens Personalize Happier where this device shows it: the sheet over the current screen on a
 * phone, the page on a computer. Without a page it resumes where this device left off.
 */
export function useOpenPersonalize(): (page?: PersonalizePageId) => void {
    const router = useRouter();
    const phone = Boolean(useOptionalWorkspaceNavigation()?.phone);
    return React.useCallback((page?: PersonalizePageId) => {
        if (phone) {
            Modal.show({
                component: PersonalizeSheetModal,
                props: { initialPage: page },
                chrome: {
                    kind: 'card',
                    header: 'none',
                    title: t('personalize.flowTitle'),
                    phonePresentation: 'sheet',
                    scrollHost: 'body',
                    testID: 'personalize-sheet.modal',
                },
            });
            return;
        }
        router.push(buildPersonalizeHref(page) as never);
    }, [phone, router]);
}
