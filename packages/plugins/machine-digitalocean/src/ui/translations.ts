import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk/manifest';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"Droplet","description":"A cloud Droplet with your chosen size, image and region.","ready":"Account connected","unavailable":"Account unavailable"},
  "de": {"kind":"Droplet","description":"Ein Cloud-Droplet mit deiner Wahl von Größe, Image und Region.","ready":"Konto verbunden","unavailable":"Konto nicht verfügbar"},
  "ru": {"kind":"Droplet","description":"Облачный Droplet с выбранными размером, образом и регионом.","ready":"Аккаунт подключён","unavailable":"Аккаунт недоступен"},
  "pl": {"kind":"Droplet","description":"Droplet z wybranym rozmiarem, obrazem i regionem.","ready":"Konto połączone","unavailable":"Konto niedostępne"},
  "es": {"kind":"Droplet","description":"Un Droplet con el tamaño, la imagen y la región elegidos.","ready":"Cuenta conectada","unavailable":"Cuenta no disponible"},
  "fr": {"kind":"Droplet","description":"Un Droplet cloud avec la taille, l’image et la région choisies.","ready":"Compte connecté","unavailable":"Compte indisponible"},
  "it": {"kind":"Droplet","description":"Un Droplet cloud con dimensione, immagine e regione scelte.","ready":"Account collegato","unavailable":"Account non disponibile"},
  "pt": {"kind":"Droplet","description":"Um Droplet com tamanho, imagem e região escolhidos.","ready":"Conta conectada","unavailable":"Conta indisponível"},
  "ca": {"kind":"Droplet","description":"Un Droplet amb la mida, la imatge i la regió triades.","ready":"Compte connectat","unavailable":"Compte no disponible"},
  "zh-Hans": {"kind":"Droplet","description":"使用所选规格、镜像和区域的云 Droplet。","ready":"账户已连接","unavailable":"账户不可用"},
  "zh-Hant": {"kind":"Droplet","description":"使用所選規格、映像和區域的雲端 Droplet。","ready":"帳戶已連接","unavailable":"帳戶不可用"},
  "ja": {"kind":"Droplet","description":"選択したサイズ、イメージ、リージョンのクラウド Droplet。","ready":"アカウント接続済み","unavailable":"アカウント利用不可"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineDigitalOcean.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}

export const DIGITALOCEAN_UI_TRANSLATION_BUNDLES: readonly UiTranslationBundle[] = Object.entries(MACHINE_PRESENTATION_LABELS).map(([locale, labels]) => ({
  locale, messages: Object.fromEntries(Object.entries(labels).map(([id, value]) => ['machineDigitalOcean.presentation.' + id, value])),
}));
