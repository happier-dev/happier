/**
 * Base rich-eligibility resolver for Node/Vitest/native resolution.
 *
 * Re-exports the NATIVE variant so the dependency graph reachable from here
 * never touches `@tiptap/*` (R18). Metro resolves `richEligibility.web.ts`
 * (which injects the web HTML round-trip) on web; that `.web` file is owned by
 * Lane F-tiptap and must NOT be created here.
 */

export * from './richEligibility.native';
