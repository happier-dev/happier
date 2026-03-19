export const PATH_BROWSER_TRIGGER_TEST_ID = 'path-browser-trigger';
export const PATH_BROWSER_MODAL_TEST_ID = 'path-browser-modal';
export const PATH_BROWSER_CONFIRM_TEST_ID = 'path-browser-confirm';

export function getPathBrowserRowTestId(path: string): string {
    return `path-browser-row:${path}`;
}

export function getPathBrowserToggleTestId(path: string): string {
    return `path-browser-toggle:${path}`;
}
