import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

const BOAT_PRESENTATION_LABELS = {
  en: {
    kind: 'sandbox',
    description: 'EU-only Boat sandboxes. Running time is billed per second; stopping pauses compute billing. Plans start at $20/month and include the same amount of usage.',
    ready: 'Account connected',
    unavailable: 'Account unavailable',
    compute: 'Running compute',
  },
  de: {
    kind: 'Sandbox',
    description: 'Boat-Sandboxes ausschließlich in der EU. Die Laufzeit wird sekundengenau abgerechnet; beim Stoppen pausiert die Abrechnung der Rechenleistung. Tarife beginnen bei 20 $/Monat und enthalten denselben Betrag als Nutzungsguthaben.',
    ready: 'Konto verbunden',
    unavailable: 'Konto nicht verfügbar',
    compute: 'Laufende Rechenleistung',
  },
  ru: {
    kind: 'песочница',
    description: 'Песочницы Boat только в ЕС. Время работы оплачивается посекундно; при остановке тарификация вычислений приостанавливается. Тарифы начинаются от 20 $/месяц и включают такой же объём использования.',
    ready: 'Аккаунт подключён',
    unavailable: 'Аккаунт недоступен',
    compute: 'Работающие вычисления',
  },
  pl: {
    kind: 'piaskownica',
    description: 'Piaskownice Boat wyłącznie w UE. Czas działania jest rozliczany co sekundę; zatrzymanie wstrzymuje naliczanie opłat za moc obliczeniową. Plany zaczynają się od 20 $/miesiąc i obejmują taką samą ilość zużycia.',
    ready: 'Konto połączone',
    unavailable: 'Konto niedostępne',
    compute: 'Działająca moc obliczeniowa',
  },
  es: {
    kind: 'sandbox',
    description: 'Sandboxes de Boat solo en la UE. El tiempo de ejecución se factura por segundo; al detenerlo se pausa la facturación del cómputo. Los planes empiezan en 20 $/mes e incluyen el mismo importe en uso.',
    ready: 'Cuenta conectada',
    unavailable: 'Cuenta no disponible',
    compute: 'Cómputo en ejecución',
  },
  fr: {
    kind: 'sandbox',
    description: 'Sandboxes Boat uniquement dans l’UE. Le temps d’exécution est facturé à la seconde ; l’arrêt met en pause la facturation du calcul. Les forfaits démarrent à 20 $/mois et incluent le même montant d’utilisation.',
    ready: 'Compte connecté',
    unavailable: 'Compte indisponible',
    compute: 'Calcul en cours',
  },
  it: {
    kind: 'sandbox',
    description: 'Sandbox Boat solo nell’UE. Il tempo di esecuzione viene fatturato al secondo; l’arresto mette in pausa la fatturazione del calcolo. I piani partono da 20 $/mese e includono lo stesso importo di utilizzo.',
    ready: 'Account collegato',
    unavailable: 'Account non disponibile',
    compute: 'Calcolo in esecuzione',
  },
  pt: {
    kind: 'sandbox',
    description: 'Sandboxes Boat somente na UE. O tempo de execução é cobrado por segundo; parar pausa a cobrança da computação. Os planos começam em US$ 20/mês e incluem o mesmo valor em uso.',
    ready: 'Conta conectada',
    unavailable: 'Conta indisponível',
    compute: 'Computação em execução',
  },
  ca: {
    kind: 'sandbox',
    description: 'Sandboxes de Boat només a la UE. El temps d’execució es factura per segon; en aturar-lo es pausa la facturació del càlcul. Els plans comencen a 20 $/mes i inclouen el mateix import en ús.',
    ready: 'Compte connectat',
    unavailable: 'Compte no disponible',
    compute: 'Càlcul en execució',
  },
  'zh-Hans': {
    kind: '沙盒',
    description: '仅限欧盟地区的 Boat 沙盒。运行时间按秒计费；停止后计算计费暂停。套餐起价为每月 20 美元，并包含等额的使用额度。',
    ready: '账户已连接',
    unavailable: '账户不可用',
    compute: '运行中的计算',
  },
  'zh-Hant': {
    kind: '沙盒',
    description: '僅限歐盟地區的 Boat 沙盒。執行時間以秒計費；停止後運算計費暫停。方案每月 20 美元起，並包含等額的使用額度。',
    ready: '帳戶已連接',
    unavailable: '帳戶不可用',
    compute: '執行中的運算',
  },
  ja: {
    kind: 'サンドボックス',
    description: 'EU 限定の Boat サンドボックスです。稼働時間は秒単位で課金され、停止するとコンピューティングの課金が一時停止します。プランは月額 20 ドルからで、同額分の利用枠が含まれます。',
    ready: 'アカウント接続済み',
    unavailable: 'アカウント利用不可',
    compute: '実行中のコンピューティング',
  },
} as const;

const en = BOAT_PRESENTATION_LABELS.en;

export function boatPresentationLabel(id: keyof typeof en): PluginLocalizedStringV2 {
  return { key: `machineBoat.presentation.${id}`, fallback: en[id] };
}

export function boatCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  return { ...result, status: result.status ?? boatPresentationLabel(result.available ? 'ready' : 'unavailable') };
}

export const BOAT_UI_TRANSLATION_BUNDLES: readonly UiTranslationBundle[] = Object.entries(BOAT_PRESENTATION_LABELS).map(([locale, labels]) => ({
  locale,
  messages: Object.fromEntries(Object.entries(labels).map(([id, value]) => [`machineBoat.presentation.${id}`, value])),
}));
