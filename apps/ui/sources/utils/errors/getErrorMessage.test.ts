import { describe, it, expect } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { installErrorUtilityCommonModuleMocks } from './errorUtilityTestHelpers';

installErrorUtilityCommonModuleMocks();

const { getErrorMessage } = await import('./getErrorMessage');

describe('getErrorMessage', () => {
    it('returns message for Error', () => {
        expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });

    it('falls back to String(error) when Error has empty message', () => {
        expect(getErrorMessage(new Error(''))).toBe('Error');
    });

    it('returns message field for plain object', () => {
        expect(getErrorMessage({ message: 'nope' })).toBe('nope');
    });

    it('returns string input as-is', () => {
        expect(getErrorMessage('oops')).toBe('oops');
    });

    it('handles nullish values', () => {
        expect(getErrorMessage(null)).toBe('');
        expect(getErrorMessage(undefined)).toBe('');
    });

    it('returns a daemon-unavailable message when rpc method is not available', () => {
        const err = new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(getErrorMessage(err)).toBe('errors.daemonUnavailableBody');
    });
});
