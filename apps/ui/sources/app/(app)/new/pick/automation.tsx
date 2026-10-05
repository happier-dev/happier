import { Redirect } from 'expo-router';

/**
 * Retained deep link for the withdrawn inline Automation picker.
 *
 * Old bookmarks open canonical workflow authoring. This route carries no draft;
 * a persisted New Session draft is still adopted by its own owner.
 */
export default function AutomationPickerRoute() {
    return <Redirect href={{ pathname: '/workflows/new' }} />;
}
