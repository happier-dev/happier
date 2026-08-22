import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    decodeRuntimeConfigArgument,
    encodeRuntimeConfigArgument,
    readRuntimeConfigFromEnvironment,
} from './runtimeConfig';

test('no runtime config is published when the host supplied none, so the app keeps its own default', () => {
    assert.equal(readRuntimeConfigFromEnvironment(() => undefined), null);
    assert.equal(readRuntimeConfigFromEnvironment(() => '   '), null);
    assert.equal(decodeRuntimeConfigArgument(['--other=1']), null);
});

test('a configured relay survives the round trip into the preload argument', () => {
    const config = readRuntimeConfigFromEnvironment((key) =>
        key === 'HAPPIER_DESKTOP_SERVER_URL' ? ' https://relay.test ' : undefined,
    );
    assert.deepEqual(config, { serverUrl: 'https://relay.test' });
    assert.deepEqual(decodeRuntimeConfigArgument([encodeRuntimeConfigArgument(config!)]), {
        serverUrl: 'https://relay.test',
    });
});

test('a malformed or empty argument is refused rather than published as a broken config', () => {
    assert.equal(decodeRuntimeConfigArgument(['--happier-runtime-config=not-json']), null);
    assert.equal(decodeRuntimeConfigArgument(['--happier-runtime-config={}']), null);
    assert.equal(decodeRuntimeConfigArgument(['--happier-runtime-config={"serverUrl":5}']), null);
});
