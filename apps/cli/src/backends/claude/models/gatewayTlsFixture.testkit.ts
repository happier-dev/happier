// Test-only TLS identity for a local gateway on 127.0.0.1: a self-signed P-256 certificate
// (SAN IP:127.0.0.1, valid until 2126) and its key. It protects nothing; tests trust it explicitly.
export const gatewayTlsFixture = {
  cert: [
    '-----BEGIN CERTIFICATE-----',
    'MIIBkDCCATagAwIBAgIUTcHPiQGdfbsBpkgGSDFJsjMP8ikwCgYIKoZIzj0EAwIw',
    'FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTEyNjE4NDcwNloYDzIxMjYxMTAy',
    'MTg0NzA2WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO',
    'PQMBBwNCAATV7bLqrNvs21ZwB5ui8wHSQ0bC+BWKUNXOEtXhV8KmAEJHgD6GmHVS',
    't+jQeh/AWhHMMwppHq/gdut73jZUoTDco2QwYjAdBgNVHQ4EFgQU8xVJGOYs3ziY',
    '6kEYY7DFvPDB7hMwHwYDVR0jBBgwFoAU8xVJGOYs3ziY6kEYY7DFvPDB7hMwDwYD',
    'VR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0gAMEUC',
    'IQCSlRDWARg8hoJmplNqyD61cO4fZrWCTny0jNgCqZ4vfwIgIUhkCubKuwR0Gu+z',
    'MCnr0GuntKrIk3emTq1eAE93+ZM=',
    '-----END CERTIFICATE-----',
  ].join('\n'),
  key: [
    '-----BEGIN PRIVATE KEY-----',
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBRMFC2CyaJNm4uIN',
    'KzSa/mFtJoZ6ezVLTOdwpKX4tX2hRANCAATV7bLqrNvs21ZwB5ui8wHSQ0bC+BWK',
    'UNXOEtXhV8KmAEJHgD6GmHVSt+jQeh/AWhHMMwppHq/gdut73jZUoTDc',
    '-----END PRIVATE KEY-----',
  ].join('\n'),
} as const;
