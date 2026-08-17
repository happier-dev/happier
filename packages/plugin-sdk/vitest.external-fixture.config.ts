import { defineConfig } from 'vitest/config';

/**
 * The external-package proof runs its own NodeNext compiler and temporary
 * package copies. Keep it independent of the repository-root Vitest setup so
 * an unrelated, partially published workspace dist cannot prevent the source
 * contract from being measured.
 */
export default defineConfig({
    test: {
        environment: 'node',
    },
});
