import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk/manifest';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"sandbox","description":"An isolated machine for coding and development.","ready":"Ready","unavailable":"Runtime unavailable","cua_native_unavailable":"Not installed","cua_connection_unavailable":"Connection unavailable","spaceKind":"space","spaceDescription":"A local workspace with its own machine and screen.","byocKind":"machine","byocDescription":"Machines on your own cloud account, managed by Cua.","fleetKind":"machine","fleetDescription":"A machine claimed from your Cua Fleet gateway.","native_facts_unknown":"Runtime response unavailable","native_runtime_unavailable":"Runtime unavailable"},
  "de": {"kind":"Sandbox","description":"Eine isolierte Maschine zum Programmieren und Entwickeln.","ready":"Bereit","unavailable":"Laufzeit nicht verfügbar","cua_native_unavailable":"Nicht installiert","cua_connection_unavailable":"Verbindung nicht verfügbar","spaceKind":"Arbeitsbereich","spaceDescription":"Ein lokaler Arbeitsbereich mit eigener Maschine und Bildschirm.","byocKind":"Maschine","byocDescription":"Maschinen in deinem Cloud-Konto, verwaltet von Cua.","fleetKind":"Maschine","fleetDescription":"Eine Maschine aus deinem Cua-Fleet-Gateway.","native_facts_unknown":"Laufzeitantwort nicht verfügbar","native_runtime_unavailable":"Laufzeit nicht verfügbar"},
  "ru": {"kind":"песочница","description":"Изолированная машина для программирования и разработки.","ready":"Готово","unavailable":"Среда недоступна","cua_native_unavailable":"Не установлено","cua_connection_unavailable":"Соединение недоступно","spaceKind":"пространство","spaceDescription":"Локальное пространство со своей машиной и экраном.","byocKind":"машина","byocDescription":"Машины в вашем облачном аккаунте под управлением Cua.","fleetKind":"машина","fleetDescription":"Машина, выделенная вашим шлюзом Cua Fleet.","native_facts_unknown":"Ответ среды недоступен","native_runtime_unavailable":"Среда недоступна"},
  "pl": {"kind":"piaskownica","description":"Izolowana maszyna do programowania i tworzenia aplikacji.","ready":"Gotowe","unavailable":"Środowisko niedostępne","cua_native_unavailable":"Nie zainstalowano","cua_connection_unavailable":"Połączenie niedostępne","spaceKind":"przestrzeń","spaceDescription":"Lokalna przestrzeń z własną maszyną i ekranem.","byocKind":"maszyna","byocDescription":"Maszyny na Twoim koncie w chmurze, zarządzane przez Cua.","fleetKind":"maszyna","fleetDescription":"Maszyna przydzielona przez Twoją bramę Cua Fleet.","native_facts_unknown":"Odpowiedź środowiska niedostępna","native_runtime_unavailable":"Środowisko niedostępne"},
  "es": {"kind":"sandbox","description":"Una máquina aislada para programar y desarrollar.","ready":"Listo","unavailable":"Entorno no disponible","cua_native_unavailable":"No instalado","cua_connection_unavailable":"Conexión no disponible","spaceKind":"espacio","spaceDescription":"Un espacio local con su propia máquina y pantalla.","byocKind":"máquina","byocDescription":"Máquinas en tu cuenta de nube, gestionadas por Cua.","fleetKind":"máquina","fleetDescription":"Una máquina asignada desde tu pasarela Cua Fleet.","native_facts_unknown":"Respuesta del entorno no disponible","native_runtime_unavailable":"Entorno no disponible"},
  "fr": {"kind":"sandbox","description":"Une machine isolée pour le code et le développement.","ready":"Prêt","unavailable":"Environnement indisponible","cua_native_unavailable":"Non installé","cua_connection_unavailable":"Connexion indisponible","spaceKind":"espace","spaceDescription":"Un espace local avec sa propre machine et son écran.","byocKind":"machine","byocDescription":"Des machines sur votre compte cloud, gérées par Cua.","fleetKind":"machine","fleetDescription":"Une machine attribuée par votre passerelle Cua Fleet.","native_facts_unknown":"Réponse de l’environnement indisponible","native_runtime_unavailable":"Environnement indisponible"},
  "it": {"kind":"sandbox","description":"Una macchina isolata per programmare e sviluppare.","ready":"Pronto","unavailable":"Ambiente non disponibile","cua_native_unavailable":"Non installato","cua_connection_unavailable":"Connessione non disponibile","spaceKind":"spazio","spaceDescription":"Uno spazio locale con la propria macchina e schermo.","byocKind":"macchina","byocDescription":"Macchine sul tuo account cloud, gestite da Cua.","fleetKind":"macchina","fleetDescription":"Una macchina assegnata dal tuo gateway Cua Fleet.","native_facts_unknown":"Risposta dell’ambiente non disponibile","native_runtime_unavailable":"Ambiente non disponibile"},
  "pt": {"kind":"sandbox","description":"Uma máquina isolada para programar e desenvolver.","ready":"Pronto","unavailable":"Ambiente indisponível","cua_native_unavailable":"Não instalado","cua_connection_unavailable":"Conexão indisponível","spaceKind":"espaço","spaceDescription":"Um espaço local com sua própria máquina e tela.","byocKind":"máquina","byocDescription":"Máquinas na sua conta de nuvem, gerenciadas pelo Cua.","fleetKind":"máquina","fleetDescription":"Uma máquina atribuída pelo seu gateway Cua Fleet.","native_facts_unknown":"Resposta do ambiente indisponível","native_runtime_unavailable":"Ambiente indisponível"},
  "ca": {"kind":"sandbox","description":"Una màquina aïllada per programar i desenvolupar.","ready":"A punt","unavailable":"Entorn no disponible","cua_native_unavailable":"No instal·lat","cua_connection_unavailable":"Connexió no disponible","spaceKind":"espai","spaceDescription":"Un espai local amb la seva màquina i pantalla.","byocKind":"màquina","byocDescription":"Màquines al teu compte de núvol, gestionades per Cua.","fleetKind":"màquina","fleetDescription":"Una màquina assignada des de la teva passarel·la Cua Fleet.","native_facts_unknown":"Resposta de l’entorn no disponible","native_runtime_unavailable":"Entorn no disponible"},
  "zh-Hans": {"kind":"沙盒","description":"用于编程和开发的隔离机器。","ready":"就绪","unavailable":"运行环境不可用","cua_native_unavailable":"未安装","cua_connection_unavailable":"连接不可用","spaceKind":"空间","spaceDescription":"拥有独立机器和屏幕的本地工作空间。","byocKind":"机器","byocDescription":"由 Cua 管理、运行在你自己的云账户上的机器。","fleetKind":"机器","fleetDescription":"从你的 Cua Fleet 网关分配的机器。","native_facts_unknown":"运行环境响应不可用","native_runtime_unavailable":"运行环境不可用"},
  "zh-Hant": {"kind":"沙盒","description":"用於程式設計和開發的隔離機器。","ready":"就緒","unavailable":"執行環境不可用","cua_native_unavailable":"未安裝","cua_connection_unavailable":"連線不可用","spaceKind":"空間","spaceDescription":"擁有獨立機器和螢幕的本地工作空間。","byocKind":"機器","byocDescription":"由 Cua 管理、執行於你自己的雲端帳戶上的機器。","fleetKind":"機器","fleetDescription":"從你的 Cua Fleet 閘道分配的機器。","native_facts_unknown":"執行環境回應不可用","native_runtime_unavailable":"執行環境不可用"},
  "ja": {"kind":"サンドボックス","description":"コーディングと開発のための隔離されたマシン。","ready":"準備完了","unavailable":"ランタイム利用不可","cua_native_unavailable":"未インストール","cua_connection_unavailable":"接続利用不可","spaceKind":"スペース","spaceDescription":"専用のマシンと画面を持つローカルワークスペース。","byocKind":"マシン","byocDescription":"自分のクラウドアカウント上で Cua が管理するマシン。","fleetKind":"マシン","fleetDescription":"Cua Fleet ゲートウェイから割り当てられるマシン。","native_facts_unknown":"ランタイムの応答を取得できません","native_runtime_unavailable":"ランタイム利用不可"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineCua.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

const CONFIGURATION_LABELS = {
  en: ['Runtime', 'Image', 'CPU cores', 'Memory (bytes)', 'Disk (bytes)', 'Cloud', 'Fleet namespace', 'Lease duration (seconds)'],
  de: ['Laufzeit', 'Image', 'CPU-Kerne', 'Arbeitsspeicher (Bytes)', 'Festplatte (Bytes)', 'Cloud', 'Fleet-Namensraum', 'Leasedauer (Sekunden)'],
  ru: ['Среда', 'Образ', 'Ядра CPU', 'Память (байты)', 'Диск (байты)', 'Облако', 'Пространство имён Fleet', 'Срок аренды (секунды)'],
  pl: ['Środowisko', 'Obraz', 'Rdzenie CPU', 'Pamięć (bajty)', 'Dysk (bajty)', 'Chmura', 'Przestrzeń nazw Fleet', 'Czas dzierżawy (sekundy)'],
  es: ['Entorno', 'Imagen', 'Núcleos de CPU', 'Memoria (bytes)', 'Disco (bytes)', 'Nube', 'Espacio de nombres de Fleet', 'Duración del arrendamiento (segundos)'],
  fr: ['Environnement', 'Image', 'Cœurs CPU', 'Mémoire (octets)', 'Disque (octets)', 'Cloud', 'Espace de noms Fleet', 'Durée du bail (secondes)'],
  it: ['Ambiente', 'Immagine', 'Core CPU', 'Memoria (byte)', 'Disco (byte)', 'Cloud', 'Namespace Fleet', 'Durata del lease (secondi)'],
  pt: ['Ambiente', 'Imagem', 'Núcleos de CPU', 'Memória (bytes)', 'Disco (bytes)', 'Nuvem', 'Espaço de nomes do Fleet', 'Duração da concessão (segundos)'],
  ca: ['Entorn', 'Imatge', 'Nuclis de CPU', 'Memòria (bytes)', 'Disc (bytes)', 'Núvol', 'Espai de noms de Fleet', 'Durada de l’arrendament (segons)'],
  'zh-Hans': ['运行环境', '镜像', 'CPU 核心', '内存（字节）', '磁盘（字节）', '云平台', 'Fleet 命名空间', '租期（秒）'],
  'zh-Hant': ['執行環境', '映像', 'CPU 核心', '記憶體（位元組）', '磁碟（位元組）', '雲端平台', 'Fleet 命名空間', '租期（秒）'],
  ja: ['ランタイム', 'イメージ', 'CPU コア', 'メモリ（バイト）', 'ディスク（バイト）', 'クラウド', 'Fleet 名前空間', 'リース期間（秒）'],
} satisfies Record<keyof typeof MACHINE_PRESENTATION_LABELS, readonly string[]>;
const configurationIds = ['runtimeId', 'imageId', 'cpu', 'memoryBytes', 'diskBytes', 'cloud', 'namespace', 'durationSeconds'] as const;
export function configurationLabel(id: typeof configurationIds[number]): PresentationLocalizedString {
  return { key: 'machineCua.configure.' + id, fallback: CONFIGURATION_LABELS.en[configurationIds.indexOf(id)] };
}

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
