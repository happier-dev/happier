import { expect, it } from 'vitest';
import { readNativeComposePorts } from './nativeComposePorts';

it('keeps exposed targets distinct from published host bindings, including TCP and UDP', () => {
    expect(readNativeComposePorts([{ '3000/tcp': null, '3000/udp': null,
        '443/tcp': [{ HostIp: '127.0.0.1', HostPort: '32768' }] }], value => value)).toEqual([
        { target: 3000, published: null, bindAddress: null, protocol: 'tcp' },
        { target: 3000, published: null, bindAddress: null, protocol: 'udp' },
        { target: 443, published: '32768', bindAddress: '127.0.0.1', protocol: 'tcp' },
    ]);
    expect(readNativeComposePorts([null], value => value)).toEqual([]);
    expect(readNativeComposePorts([{ malformed: null }], value => value)).toBeNull();
});
