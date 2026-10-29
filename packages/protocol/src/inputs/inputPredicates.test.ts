import { describe, expect, it } from 'vitest';
import { evaluateInputPredicate, readInputPath } from './inputPredicates.js';

describe('reviewed input path traversal', () => {
    it('reads only own reviewed fields, including explicitly named prototype-like JSON keys', () => {
        const input: unknown = JSON.parse('{"receiver":{"username":"backup"},"constructor":{"name":"reviewed"},"__proto__":{"name":"explicit"}}');
        expect(readInputPath(input, 'receiver.username')).toBe('backup');
        expect(readInputPath(input, 'constructor.name')).toBe('reviewed');
        expect(readInputPath(input, '__proto__.name')).toBe('explicit');
        expect(readInputPath({ receiver: {} }, 'receiver.toString')).toBeUndefined();
        expect(readInputPath({}, 'constructor.name')).toBeUndefined();
        expect(evaluateInputPredicate({ op: 'truthy', path: 'receiver.toString' }, { receiver: {} })).toBe(false);
    });
});
