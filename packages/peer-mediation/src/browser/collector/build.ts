import { INJECTED_CONSOLE_RUNTIME } from './console.js';
import { INJECTED_ELEMENTS_RUNTIME, INJECTED_DOM_SNAPSHOT_RUNTIME } from './elements.js';
import { INJECTED_EVAL_RUNTIME } from './eval.js';
import {
    INJECTED_LIFECYCLE_BOOTSTRAP,
    INJECTED_LIFECYCLE_COMMANDS,
    INJECTED_LIFECYCLE_FOOTER,
    INJECTED_LIFECYCLE_PAGE_RUNTIME,
} from './lifecycle.js';
import { INJECTED_COOPERATIVE_NAVIGATION_RUNTIME } from './navigation.js';
import { INJECTED_NETWORK_HELPERS, INJECTED_NETWORK_INTERCEPTORS } from './network.js';
import { INJECTED_OBJECT_INSPECTOR_RUNTIME } from './objectInspector.js';
import { INJECTED_SANITIZE_RUNTIME } from './sanitize.js';
import { INJECTED_STORAGE_RUNTIME } from './storage.js';
export { buildDesktopBrowserKeyboardScript } from './keyboard.js';

export function buildInjectedBrowserDiagnosticsRuntimeScript(config: string): string {
    return [
        `(function () {\n  var config = ${config};\n`,
        INJECTED_LIFECYCLE_BOOTSTRAP,
        INJECTED_SANITIZE_RUNTIME,
        INJECTED_NETWORK_HELPERS,
        INJECTED_OBJECT_INSPECTOR_RUNTIME,
        INJECTED_EVAL_RUNTIME,
        INJECTED_ELEMENTS_RUNTIME,
        INJECTED_LIFECYCLE_COMMANDS,
        INJECTED_CONSOLE_RUNTIME,
        INJECTED_LIFECYCLE_PAGE_RUNTIME,
        INJECTED_STORAGE_RUNTIME,
        INJECTED_DOM_SNAPSHOT_RUNTIME,
        INJECTED_NETWORK_INTERCEPTORS,
        INJECTED_LIFECYCLE_FOOTER,
        `  if (config.cooperativePreview) {${INJECTED_COOPERATIVE_NAVIGATION_RUNTIME}  }\n`,
        '})(); true;\n',
    ].join('');
}

/** The reporter alone, for the in-frame documents that follow the pane's own navigation. */
export function buildCooperativeNavigationRuntimeScript(config: string): string {
    return `(function () {\n  var config = ${config};\n${INJECTED_COOPERATIVE_NAVIGATION_RUNTIME}})(); true;\n`;
}
