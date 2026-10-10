/** Provider-owned import failures that can be reported without exposing credential or filesystem details. */
export class ConnectedServiceImportProviderError extends Error {
  constructor(readonly code: 'project_required' | 'account_ineligible') {
    super('The provider could not verify this login for import');
    this.name = 'ConnectedServiceImportProviderError';
  }
}
