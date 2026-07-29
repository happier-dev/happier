import { INJECTED_CONSOLE_RUNTIME } from './console';
import { INJECTED_ELEMENTS_RUNTIME, INJECTED_DOM_SNAPSHOT_RUNTIME } from './elements';
import { INJECTED_EVAL_RUNTIME } from './eval';
import {
    INJECTED_LIFECYCLE_BOOTSTRAP,
    INJECTED_LIFECYCLE_COMMANDS,
    INJECTED_LIFECYCLE_FOOTER,
    INJECTED_LIFECYCLE_PAGE_RUNTIME,
} from './lifecycle';
import { INJECTED_NETWORK_HELPERS, INJECTED_NETWORK_INTERCEPTORS } from './network';
import { INJECTED_OBJECT_INSPECTOR_RUNTIME } from './objectInspector';
import { INJECTED_SANITIZE_RUNTIME } from './sanitize';
import { INJECTED_STORAGE_RUNTIME } from './storage';

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
        '})(); true;\n',
    ].join('');
}
