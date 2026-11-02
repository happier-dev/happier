import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"sandbox","description":"An isolated machine for coding and development.","ready":"Ready","unavailable":"Runtime unavailable","cua_native_unavailable":"Not installed · get it from cua.ai","cua_native_outdated":"Update required · update the Cua CLI","cua_connection_unavailable":"Connection unavailable","credential_unavailable":"No account yet","spaceKind":"space","spaceDescription":"A local workspace with its own machine and screen.","byocKind":"machine","byocDescription":"Machines on your own cloud account, managed by Cua.","native_facts_unknown":"Runtime response unavailable","native_runtime_unavailable":"Runtime unavailable"},
  "de": {"kind":"Sandbox","description":"Eine isolierte Maschine zum Programmieren und Entwickeln.","ready":"Bereit","unavailable":"Laufzeit nicht verfügbar","cua_native_unavailable":"Nicht installiert · von cua.ai holen","cua_native_outdated":"Update erforderlich · Cua CLI aktualisieren","cua_connection_unavailable":"Verbindung nicht verfügbar","credential_unavailable":"Noch kein Konto","spaceKind":"Arbeitsbereich","spaceDescription":"Ein lokaler Arbeitsbereich mit eigener Maschine und Bildschirm.","byocKind":"Maschine","byocDescription":"Maschinen in deinem Cloud-Konto, verwaltet von Cua.","native_facts_unknown":"Laufzeitantwort nicht verfügbar","native_runtime_unavailable":"Laufzeit nicht verfügbar"},
  "ru": {"kind":"песочница","description":"Изолированная машина для программирования и разработки.","ready":"Готово","unavailable":"Среда недоступна","cua_native_unavailable":"Не установлено · скачайте на cua.ai","cua_native_outdated":"Требуется обновление · обновите Cua CLI","cua_connection_unavailable":"Соединение недоступно","credential_unavailable":"Нет учётной записи","spaceKind":"пространство","spaceDescription":"Локальное пространство со своей машиной и экраном.","byocKind":"машина","byocDescription":"Машины в вашем облачном аккаунте под управлением Cua.","native_facts_unknown":"Ответ среды недоступен","native_runtime_unavailable":"Среда недоступна"},
  "pl": {"kind":"piaskownica","description":"Izolowana maszyna do programowania i tworzenia aplikacji.","ready":"Gotowe","unavailable":"Środowisko niedostępne","cua_native_unavailable":"Nie zainstalowano · pobierz z cua.ai","cua_native_outdated":"Wymagana aktualizacja · zaktualizuj Cua CLI","cua_connection_unavailable":"Połączenie niedostępne","credential_unavailable":"Brak konta","spaceKind":"przestrzeń","spaceDescription":"Lokalna przestrzeń z własną maszyną i ekranem.","byocKind":"maszyna","byocDescription":"Maszyny na Twoim koncie w chmurze, zarządzane przez Cua.","native_facts_unknown":"Odpowiedź środowiska niedostępna","native_runtime_unavailable":"Środowisko niedostępne"},
  "es": {"kind":"sandbox","description":"Una máquina aislada para programar y desarrollar.","ready":"Listo","unavailable":"Entorno no disponible","cua_native_unavailable":"No instalado · descárgalo en cua.ai","cua_native_outdated":"Actualización necesaria · actualiza Cua CLI","cua_connection_unavailable":"Conexión no disponible","credential_unavailable":"Aún sin cuenta","spaceKind":"espacio","spaceDescription":"Un espacio local con su propia máquina y pantalla.","byocKind":"máquina","byocDescription":"Máquinas en tu cuenta de nube, gestionadas por Cua.","native_facts_unknown":"Respuesta del entorno no disponible","native_runtime_unavailable":"Entorno no disponible"},
  "fr": {"kind":"sandbox","description":"Une machine isolée pour le code et le développement.","ready":"Prêt","unavailable":"Environnement indisponible","cua_native_unavailable":"Non installé · à obtenir sur cua.ai","cua_native_outdated":"Mise à jour requise · mets à jour Cua CLI","cua_connection_unavailable":"Connexion indisponible","credential_unavailable":"Pas encore de compte","spaceKind":"espace","spaceDescription":"Un espace local avec sa propre machine et son écran.","byocKind":"machine","byocDescription":"Des machines sur ton compte cloud, gérées par Cua.","native_facts_unknown":"Réponse de l’environnement indisponible","native_runtime_unavailable":"Environnement indisponible"},
  "it": {"kind":"sandbox","description":"Una macchina isolata per programmare e sviluppare.","ready":"Pronto","unavailable":"Ambiente non disponibile","cua_native_unavailable":"Non installato · scaricalo da cua.ai","cua_native_outdated":"Aggiornamento necessario · aggiorna Cua CLI","cua_connection_unavailable":"Connessione non disponibile","credential_unavailable":"Nessun account","spaceKind":"spazio","spaceDescription":"Uno spazio locale con la propria macchina e schermo.","byocKind":"macchina","byocDescription":"Macchine sul tuo account cloud, gestite da Cua.","native_facts_unknown":"Risposta dell’ambiente non disponibile","native_runtime_unavailable":"Ambiente non disponibile"},
  "pt": {"kind":"sandbox","description":"Uma máquina isolada para programar e desenvolver.","ready":"Pronto","unavailable":"Ambiente indisponível","cua_native_unavailable":"Não instalado · baixe em cua.ai","cua_native_outdated":"Atualização necessária · atualize o Cua CLI","cua_connection_unavailable":"Conexão indisponível","credential_unavailable":"Ainda sem conta","spaceKind":"espaço","spaceDescription":"Um espaço local com sua própria máquina e tela.","byocKind":"máquina","byocDescription":"Máquinas na sua conta de nuvem, gerenciadas pelo Cua.","native_facts_unknown":"Resposta do ambiente indisponível","native_runtime_unavailable":"Ambiente indisponível"},
  "ca": {"kind":"sandbox","description":"Una màquina aïllada per programar i desenvolupar.","ready":"A punt","unavailable":"Entorn no disponible","cua_native_unavailable":"No instal·lat · baixa’l de cua.ai","cua_native_outdated":"Cal actualitzar · actualitza Cua CLI","cua_connection_unavailable":"Connexió no disponible","credential_unavailable":"Encara sense compte","spaceKind":"espai","spaceDescription":"Un espai local amb la seva màquina i pantalla.","byocKind":"màquina","byocDescription":"Màquines al teu compte de núvol, gestionades per Cua.","native_facts_unknown":"Resposta de l’entorn no disponible","native_runtime_unavailable":"Entorn no disponible"},
  "zh-Hans": {"kind":"沙盒","description":"用于编程和开发的隔离机器。","ready":"就绪","unavailable":"运行环境不可用","cua_native_unavailable":"未安装 · 请从 cua.ai 获取","cua_native_outdated":"需要更新 · 请更新 Cua CLI","cua_connection_unavailable":"连接不可用","credential_unavailable":"尚无账号","spaceKind":"空间","spaceDescription":"拥有独立机器和屏幕的本地工作空间。","byocKind":"机器","byocDescription":"由 Cua 管理、运行在你自己的云账户上的机器。","native_facts_unknown":"运行环境响应不可用","native_runtime_unavailable":"运行环境不可用"},
  "zh-Hant": {"kind":"沙盒","description":"用於程式設計和開發的隔離機器。","ready":"就緒","unavailable":"執行環境不可用","cua_native_unavailable":"未安裝 · 請從 cua.ai 取得","cua_native_outdated":"需要更新 · 請更新 Cua CLI","cua_connection_unavailable":"連線不可用","credential_unavailable":"尚無帳號","spaceKind":"空間","spaceDescription":"擁有獨立機器和螢幕的本地工作空間。","byocKind":"機器","byocDescription":"由 Cua 管理、執行於你自己的雲端帳戶上的機器。","native_facts_unknown":"執行環境回應不可用","native_runtime_unavailable":"執行環境不可用"},
  "ja": {"kind":"サンドボックス","description":"コーディングと開発のための隔離されたマシン。","ready":"準備完了","unavailable":"ランタイム利用不可","cua_native_unavailable":"未インストール · cua.ai から入手","cua_native_outdated":"更新が必要 · Cua CLI を更新","cua_connection_unavailable":"接続利用不可","credential_unavailable":"アカウントなし","spaceKind":"スペース","spaceDescription":"専用のマシンと画面を持つローカルワークスペース。","byocKind":"マシン","byocDescription":"自分のクラウドアカウント上で Cua が管理するマシン。","native_facts_unknown":"ランタイムの応答を取得できません","native_runtime_unavailable":"ランタイム利用不可"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineCua.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

const CONFIGURATION_LABELS = {
  en: ['CPU cores', 'Memory', 'Disk', 'Cloud'],
  de: ['CPU-Kerne', 'Arbeitsspeicher', 'Festplatte', 'Cloud'],
  ru: ['Ядра CPU', 'Память', 'Диск', 'Облако'],
  pl: ['Rdzenie CPU', 'Pamięć', 'Dysk', 'Chmura'],
  es: ['Núcleos de CPU', 'Memoria', 'Disco', 'Nube'],
  fr: ['Cœurs CPU', 'Mémoire', 'Disque', 'Cloud'],
  it: ['Core CPU', 'Memoria', 'Disco', 'Cloud'],
  pt: ['Núcleos de CPU', 'Memória', 'Disco', 'Nuvem'],
  ca: ['Nuclis de CPU', 'Memòria', 'Disc', 'Núvol'],
  'zh-Hans': ['CPU 核心', '内存', '磁盘', '云平台'],
  'zh-Hant': ['CPU 核心', '記憶體', '磁碟', '雲端平台'],
  ja: ['CPU コア', 'メモリ', 'ディスク', 'クラウド'],
} satisfies Record<keyof typeof MACHINE_PRESENTATION_LABELS, readonly string[]>;
const configurationIds = ['cpu', 'memoryBytes', 'diskBytes', 'cloud'] as const;
export function configurationLabel(id: typeof configurationIds[number]): PresentationLocalizedString {
  return { key: 'machineCua.configure.' + id, fallback: CONFIGURATION_LABELS.en[configurationIds.indexOf(id)] };
}

/** One name per connected native account, wherever Happier shows it (service title, connected account, status). */
export const CUA_ACCOUNT_NAMES = { cloud: 'Cua cloud account', cua: 'Cua login' } as const;

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}

export const CUA_UI_TRANSLATION_BUNDLES: readonly UiTranslationBundle[] = Object.entries(MACHINE_PRESENTATION_LABELS).map(([locale, labels]) => ({
  locale, messages: Object.fromEntries([
    ...Object.entries(labels).map(([id, value]) => ['machineCua.presentation.' + id, value]),
    ...configurationIds.map((id, index) => ['machineCua.configure.' + id, CONFIGURATION_LABELS[locale as keyof typeof CONFIGURATION_LABELS][index]]),
  ]),
}));
