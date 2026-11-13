import * as React from 'react';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import type { AlreadyUsePath } from '../alreadyUse/alreadyUsePaths';
import { HomeAddForm } from '../../add/HomeAddForm';

/** The doorway paths that open as a sheet; connecting to a Home directly is a step of the welcome. */
export type AlreadyUseSheetPath = Exclude<AlreadyUsePath, 'direct'>;

/**
 * One path of "Already use Happier?" as a phone sheet (lab K1p): the Add a Home form's pane on its own
 * (`HomeAddForm layout="sheet"`), since the doorway's buttons are the paths. The form decides whether
 * the phone opens the Home it connects (a phone with no Home of its own does).
 */
export function AlreadyUseHappierSheet(props: CustomModalInjectedProps & Readonly<{ initialPath: AlreadyUseSheetPath }>) {
    return <HomeAddForm layout="sheet" testID="already-use-happier-sheet" initialPath={props.initialPath} onClose={props.onClose} />;
}

const SHEET_TITLE_KEYS: Readonly<Record<AlreadyUseSheetPath, 'signIn' | 'pathOtherServiceTitle'>> = {
    service: 'signIn',
    other_service: 'pathOtherServiceTitle',
};

/** Opens one path of the phone doorway as a sheet. */
export function presentAlreadyUseHappierSheet(initialPath: AlreadyUseSheetPath): string {
    return Modal.show({
        component: AlreadyUseHappierSheet,
        props: { initialPath },
        closeOnBackdrop: true,
        chrome: {
            kind: 'card',
            // The pane titles itself; the title stays the sheet's accessible name (one title on screen).
            header: 'none',
            phonePresentation: 'sheet',
            title: t(`homesJourneys.${SHEET_TITLE_KEYS[initialPath]}`),
            testID: 'already-use-happier-sheet',
        },
    });
}
