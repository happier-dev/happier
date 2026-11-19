import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const script = readFileSync(new URL('../../../src-tauri/src/desktop_web_runtime_config.js', import.meta.url), 'utf8');
const launchHome = 'https://home-a.example.test';
const policy = '{"organization":"fixture"}';

function startWebview(label: string, path: string) {
    const location = new URL(path, 'https://desktop.example.test');
    const window = {
        location,
        __TAURI_INTERNALS__: { metadata: { currentWindow: { label } } },
        __HAPPIER_WEB_RUNTIME_CONFIG__: { serverContext: 'stack' },
        history: {
            replaceState(_state: unknown, _unused: string, url: string) {
                location.href = url;
            },
        },
    };
    runInNewContext(`(${script})(config, 'main')`, {
        window,
        URL,
        config: { serverUrl: launchHome, organizationPolicyJson: policy },
    });
    return window;
}

it('applies the launch Home to the primary window URL and merges the runtime configuration', () => {
    const window = startWebview('main', '/?happier_hmr=0');
    expect(window.location.searchParams.get('server')).toBe(launchHome);
    expect(window.location.searchParams.get('happier_hmr')).toBe('0');
    expect(window.__HAPPIER_WEB_RUNTIME_CONFIG__).toMatchObject({ serverContext: 'stack', serverUrl: launchHome });
});

it.each([
    ['destination_full', '/desktop/app-window'],
    ['destination_compact', '/desktop/window'],
    ['activity_overlay', '/desktop/activity-overlay'],
])('applies organization policy without selecting the launch Home in %s', (label, path) => {
    const window = startWebview(label, path);
    expect(window.location.searchParams.has('server')).toBe(false);
    expect(window.__HAPPIER_WEB_RUNTIME_CONFIG__).toMatchObject({ organizationPolicyJson: policy });
});
