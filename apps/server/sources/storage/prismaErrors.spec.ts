import { describe, expect, it } from 'vitest';
import { readPrismaQueryValidationDiagnostic, withPrismaQueryValidationDiagnostic } from './prismaErrors';

describe('Prisma validation diagnostics', () => {
    it.each([
        { summary: 'Unknown argument `reporterMachineId`. Did you mean `id`?', expected: ['Unknown argument: reporterMachineId'] },
        { summary: 'Unknown field `reporterMachineId` for select statement on model `Account`.', expected: ['Unknown field: reporterMachineId'] },
        { summary: 'Argument `where` is missing.', expected: ['Missing argument: where'] },
        { summary: 'Argument `id` must not be null.', expected: ['Null argument: id'] },
        { summary: 'Invalid value for argument `id`: private-query-value', expected: ['Invalid argument value: id'] },
        { summary: 'Argument `where` of type AccountWhereUniqueInput needs at least one of `id` or `publicKey` arguments.', expected: ['Missing required selection: where (id, publicKey)'] },
        { summary: 'Unrecognized future validation prose: private-query-value', expected: [] },
    ])('projects only field names from $summary', ({ summary, expected }) => {
        // Prisma is the external boundary. Include invocation data as its real errors do.
        const original = Object.assign(new Error(`Invalid invocation:\n{ id: "private-query-value" }\n\n${summary}`), {
            name: 'PrismaClientValidationError',
        });
        const error = withPrismaQueryValidationDiagnostic(original, { model: 'Account', operation: 'findMany' });
        expect(readPrismaQueryValidationDiagnostic(withPrismaQueryValidationDiagnostic(original))).toMatchObject({
            prismaModel: null, prismaOperation: null, validationSummary: expected,
        });
        expect(readPrismaQueryValidationDiagnostic(error)).toEqual({
            errorCode: 'database_query_validation_failed', httpStatus: 500,
            prismaModel: 'Account', prismaOperation: 'findMany', validationSummary: expected,
        });
        expect(error).toMatchObject({ code: 'database_query_validation_failed', statusCode: 500 });
        expect(String(error)).not.toContain('private-query-value');
        expect(error instanceof Error ? error.stack : '').not.toContain('private-query-value');
        expect(withPrismaQueryValidationDiagnostic(error, { operation: '$transaction' })).toBe(error);
    });

    it('leaves non-validation failures with their original identity and metadata', () => {
        const error = Object.assign(new Error('private-query-value'), { code: 'P2002', meta: { target: ['id'] } });
        expect(withPrismaQueryValidationDiagnostic(error, { model: 'Account', operation: 'create' })).toBe(error);
        expect(readPrismaQueryValidationDiagnostic(error)).toBeNull();
    });
});
