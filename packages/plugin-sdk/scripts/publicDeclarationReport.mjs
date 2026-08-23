// The repository API-governance owner holds the shared declaration traversal.
// Keep this package-local forwarding module so existing package tooling and
// focused tests retain their stable entrypoint without a peer-package import.
export * from '../../../scripts/api-governance/publicDeclarationReport.mjs';
