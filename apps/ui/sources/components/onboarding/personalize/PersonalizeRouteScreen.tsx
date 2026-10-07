import * as React from 'react';

import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDeviceType } from '@/utils/platform/responsive';

import { PersonalizeFlowView } from './PersonalizeFlowView';
import { PERSONALIZE_PAGES, type PersonalizePageId } from './personalizeFlowModel';
import { PERSONALIZE_PAGE_PARAM } from './useOpenPersonalize';

function readPageParam(value: string | string[] | undefined): PersonalizePageId | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    return (PERSONALIZE_PAGES as readonly string[]).includes(raw ?? '') ? raw as PersonalizePageId : undefined;
}

/** `/personalize`: the flow as a page (a sheet's layout on a phone); without `?page=` it resumes. */
export function PersonalizeRouteScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<Record<string, string | string[]>>();
    const isPhone = useDeviceType() === 'phone';
    const initialPage = readPageParam(params[PERSONALIZE_PAGE_PARAM]);
    const exit = React.useCallback(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/' as never);
    }, [router]);
    return <PersonalizeFlowView initialPage={initialPage} onExit={exit} presentation={isPhone ? 'phone' : 'desktop'} />;
}
