/** Payload-free contract failure, shared by HTTP admission and source orchestration. */
export class TeamCredentialDirectMaterialHttpContractError extends Error {
  constructor() {
    super('team_credential_direct_material_http_contract_invalid');
    this.name = 'TeamCredentialDirectMaterialHttpContractError';
  }
}
