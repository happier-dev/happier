export async function confirmAccountVoiceCredentialWrite(params: Readonly<{
  disclosePlainStorage: boolean;
  resolveAccountMode: () => Promise<'e2ee' | 'plain'>;
  confirm: () => Promise<boolean>;
}>): Promise<boolean> {
  if (!params.disclosePlainStorage) return true;
  return await params.resolveAccountMode() === 'plain' ? await params.confirm() : true;
}
