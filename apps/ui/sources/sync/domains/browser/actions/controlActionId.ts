import type { BrowserCommandV1, RuntimeActionIdV1 } from '@happier-dev/protocol';

/** Closed Browser command variants enter their existing, exact semantic Actions. */
const CONTROL_ACTION_IDS = {
    takeControl: 'browser.control.takeControl',
    handBack: 'browser.control.handBack',
    openView: 'browser.view.open',
    closeView: 'browser.view.close',
    focusView: 'browser.view.focus',
    setTarget: 'browser.target.set',
    navigate: 'browser.navigate',
    reload: 'browser.reload',
    goBack: 'browser.goBack',
    goForward: 'browser.goForward',
    stop: 'browser.stop',
} as const satisfies Record<BrowserCommandV1['kind'], RuntimeActionIdV1>;

export function browserControlActionId(command: BrowserCommandV1) {
    return CONTROL_ACTION_IDS[command.kind];
}
