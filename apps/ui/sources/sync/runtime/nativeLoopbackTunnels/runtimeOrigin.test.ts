import { describe, expect, it } from 'vitest';
import { resolveServerRuntimeOrigin } from './runtimeOrigin';

describe('runtime origin resolver', () => {
    it('uses an active Iroh origin only while carrier is Iroh', () => {
        expect(resolveServerRuntimeOrigin({ serverUrl: 'https://home.example', carrier: 'iroh', runtimeOrigin: 'http://127.0.0.1:4312/' })).toBe('http://127.0.0.1:4312');
        expect(resolveServerRuntimeOrigin({ serverUrl: 'https://home.example', carrier: 'https', runtimeOrigin: 'http://127.0.0.1:4312' })).toBe('https://home.example');
    });

    it('fails closed to the stable origin for malformed native origins', () => {
        expect(resolveServerRuntimeOrigin({ serverUrl: 'https://home.example/', carrier: 'iroh', runtimeOrigin: 'javascript:alert(1)' })).toBe('https://home.example');
        expect(resolveServerRuntimeOrigin({ serverUrl: 'https://home.example/', carrier: 'iroh', runtimeOrigin: 'http://user:pass@127.0.0.1:4312' })).toBe('https://home.example');
    });
});
