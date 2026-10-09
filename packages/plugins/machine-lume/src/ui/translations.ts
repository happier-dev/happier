import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk/manifest';
import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

export const LUME_CONFIGURATION_LABELS = {
  en: {
    storage: 'Storage', storageDescription: 'Exact native storage name from the available locations.',
    cpu: 'CPU cores', memory: 'Memory in bytes', disk: 'Disk size in bytes', imageKind: 'Image selection',
    publishedImage: 'Published image', nativeReference: 'Native image reference', publishedReference: 'Published image reference',
    nativeDescription: 'A tagged or digest-qualified Lume-format image prepared for this guest.',
    privateCarrier: 'Prepared private connection',
    privateDescription: 'Select only for a reviewed image prepared for native Lume default-password SSH.',
    preparedSsh: 'Prepared for native Lume SSH', guestOs: 'Prepared guest OS', user: 'Prepared SSH user',
    userDescription: 'The explicit account prepared in this image; it is never inferred from the guest OS.', customSize: 'Custom size',
  },
  de: {
    storage: 'Speicherort', storageDescription: 'Der genaue native Speichername aus den verfügbaren Speicherorten.',
    cpu: 'CPU-Kerne', memory: 'Arbeitsspeicher in Bytes', disk: 'Festplattengröße in Bytes', imageKind: 'Image-Auswahl',
    publishedImage: 'Veröffentlichtes Image', nativeReference: 'Native Image-Referenz', publishedReference: 'Referenz des veröffentlichten Images',
    nativeDescription: 'Ein für diesen Gast vorbereitetes Image im Lume-Format mit Tag oder Digest.',
    privateCarrier: 'Vorbereitete private Verbindung',
    privateDescription: 'Nur für ein geprüftes Image wählen, das für natives Lume-SSH mit Standardpasswort vorbereitet ist.',
    preparedSsh: 'Für natives Lume-SSH vorbereitet', guestOs: 'Vorbereitetes Gast-Betriebssystem', user: 'Vorbereiteter SSH-Benutzer',
    userDescription: 'Das ausdrücklich in diesem Image vorbereitete Konto; es wird nie aus dem Gast-Betriebssystem abgeleitet.', customSize: 'Benutzerdefinierte Größe',
  },
  ru: {
    storage: 'Хранилище', storageDescription: 'Точное нативное имя хранилища из доступных расположений.',
    cpu: 'Ядра CPU', memory: 'Память в байтах', disk: 'Размер диска в байтах', imageKind: 'Выбор образа',
    publishedImage: 'Опубликованный образ', nativeReference: 'Ссылка на нативный образ', publishedReference: 'Ссылка на опубликованный образ',
    nativeDescription: 'Образ в формате Lume с тегом или дайджестом, подготовленный для этого гостя.',
    privateCarrier: 'Подготовленное приватное подключение',
    privateDescription: 'Выбирайте только проверенный образ, подготовленный для нативного SSH Lume с паролем по умолчанию.',
    preparedSsh: 'Подготовлен для нативного SSH Lume', guestOs: 'Подготовленная гостевая ОС', user: 'Подготовленный пользователь SSH',
    userDescription: 'Явно подготовленная в этом образе учётная запись; она никогда не определяется по гостевой ОС.', customSize: 'Произвольный размер',
  },
  pl: {
    storage: 'Magazyn', storageDescription: 'Dokładna natywna nazwa magazynu z dostępnych lokalizacji.',
    cpu: 'Rdzenie CPU', memory: 'Pamięć w bajtach', disk: 'Rozmiar dysku w bajtach', imageKind: 'Wybór obrazu',
    publishedImage: 'Opublikowany obraz', nativeReference: 'Odwołanie do natywnego obrazu', publishedReference: 'Odwołanie do opublikowanego obrazu',
    nativeDescription: 'Obraz w formacie Lume z tagiem lub skrótem, przygotowany dla tego gościa.',
    privateCarrier: 'Przygotowane połączenie prywatne',
    privateDescription: 'Wybierz tylko sprawdzony obraz przygotowany do natywnego SSH Lume z domyślnym hasłem.',
    preparedSsh: 'Przygotowany do natywnego SSH Lume', guestOs: 'Przygotowany system gościa', user: 'Przygotowany użytkownik SSH',
    userDescription: 'Konto jawnie przygotowane w tym obrazie; nigdy nie jest ustalane na podstawie systemu gościa.', customSize: 'Własny rozmiar',
  },
  es: {
    storage: 'Almacenamiento', storageDescription: 'El nombre nativo exacto del almacenamiento entre las ubicaciones disponibles.',
    cpu: 'Núcleos de CPU', memory: 'Memoria en bytes', disk: 'Tamaño del disco en bytes', imageKind: 'Selección de imagen',
    publishedImage: 'Imagen publicada', nativeReference: 'Referencia de imagen nativa', publishedReference: 'Referencia de imagen publicada',
    nativeDescription: 'Una imagen en formato Lume con etiqueta o resumen, preparada para este huésped.',
    privateCarrier: 'Conexión privada preparada',
    privateDescription: 'Selecciona solo una imagen revisada y preparada para SSH nativo de Lume con la contraseña predeterminada.',
    preparedSsh: 'Preparada para SSH nativo de Lume', guestOs: 'Sistema del huésped preparado', user: 'Usuario SSH preparado',
    userDescription: 'La cuenta preparada explícitamente en esta imagen; nunca se deduce del sistema del huésped.', customSize: 'Tamaño personalizado',
  },
  fr: {
    storage: 'Stockage', storageDescription: 'Le nom natif exact du stockage parmi les emplacements disponibles.',
    cpu: 'Cœurs du processeur', memory: 'Mémoire en octets', disk: 'Taille du disque en octets', imageKind: 'Choix de l’image',
    publishedImage: 'Image publiée', nativeReference: 'Référence d’image native', publishedReference: 'Référence d’image publiée',
    nativeDescription: 'Une image au format Lume avec une étiquette ou une empreinte, préparée pour cet invité.',
    privateCarrier: 'Connexion privée préparée',
    privateDescription: 'Sélectionnez uniquement une image vérifiée et préparée pour SSH natif Lume avec le mot de passe par défaut.',
    preparedSsh: 'Préparée pour SSH natif Lume', guestOs: 'Système invité préparé', user: 'Utilisateur SSH préparé',
    userDescription: 'Le compte explicitement préparé dans cette image ; il n’est jamais déduit du système invité.', customSize: 'Taille personnalisée',
  },
  it: {
    storage: 'Archiviazione', storageDescription: 'Il nome nativo esatto dell’archiviazione tra le posizioni disponibili.',
    cpu: 'Core CPU', memory: 'Memoria in byte', disk: 'Dimensione del disco in byte', imageKind: 'Selezione dell’immagine',
    publishedImage: 'Immagine pubblicata', nativeReference: 'Riferimento all’immagine nativa', publishedReference: 'Riferimento all’immagine pubblicata',
    nativeDescription: 'Un’immagine in formato Lume con tag o digest, preparata per questo ospite.',
    privateCarrier: 'Connessione privata preparata',
    privateDescription: 'Seleziona solo un’immagine verificata e preparata per SSH nativo Lume con la password predefinita.',
    preparedSsh: 'Preparata per SSH nativo Lume', guestOs: 'Sistema ospite preparato', user: 'Utente SSH preparato',
    userDescription: 'L’account preparato esplicitamente in questa immagine; non viene mai dedotto dal sistema ospite.', customSize: 'Dimensione personalizzata',
  },
  pt: {
    storage: 'Armazenamento', storageDescription: 'O nome nativo exato do armazenamento entre os locais disponíveis.',
    cpu: 'Núcleos de CPU', memory: 'Memória em bytes', disk: 'Tamanho do disco em bytes', imageKind: 'Seleção da imagem',
    publishedImage: 'Imagem publicada', nativeReference: 'Referência da imagem nativa', publishedReference: 'Referência da imagem publicada',
    nativeDescription: 'Uma imagem no formato Lume com tag ou resumo, preparada para este hóspede.',
    privateCarrier: 'Conexão privada preparada',
    privateDescription: 'Selecione apenas uma imagem revisada e preparada para SSH nativo do Lume com a senha padrão.',
    preparedSsh: 'Preparada para SSH nativo do Lume', guestOs: 'Sistema hóspede preparado', user: 'Usuário SSH preparado',
    userDescription: 'A conta preparada explicitamente nesta imagem; ela nunca é deduzida do sistema hóspede.', customSize: 'Tamanho personalizado',
  },
  ca: {
    storage: 'Emmagatzematge', storageDescription: 'El nom natiu exacte de l’emmagatzematge entre les ubicacions disponibles.',
    cpu: 'Nuclis de CPU', memory: 'Memòria en bytes', disk: 'Mida del disc en bytes', imageKind: 'Selecció de la imatge',
    publishedImage: 'Imatge publicada', nativeReference: 'Referència de la imatge nativa', publishedReference: 'Referència de la imatge publicada',
    nativeDescription: 'Una imatge en format Lume amb etiqueta o resum, preparada per a aquest convidat.',
    privateCarrier: 'Connexió privada preparada',
    privateDescription: 'Selecciona només una imatge revisada i preparada per a SSH natiu de Lume amb la contrasenya predeterminada.',
    preparedSsh: 'Preparada per a SSH natiu de Lume', guestOs: 'Sistema convidat preparat', user: 'Usuari SSH preparat',
    userDescription: 'El compte preparat explícitament en aquesta imatge; mai no es dedueix del sistema convidat.', customSize: 'Mida personalitzada',
  },
  'zh-Hans': {
    storage: '存储位置', storageDescription: '可用位置中的确切原生存储名称。',
    cpu: 'CPU 核心数', memory: '内存（字节）', disk: '磁盘大小（字节）', imageKind: '镜像选择',
    publishedImage: '已发布镜像', nativeReference: '原生镜像引用', publishedReference: '已发布镜像引用',
    nativeDescription: '为此客户机准备的带标签或摘要的 Lume 格式镜像。',
    privateCarrier: '已准备的私有连接', privateDescription: '仅选择经过审核并为使用默认密码的 Lume 原生 SSH 准备好的镜像。',
    preparedSsh: '已为 Lume 原生 SSH 准备', guestOs: '已准备的客户机系统', user: '已准备的 SSH 用户',
    userDescription: '在此镜像中明确准备的账户；绝不会根据客户机系统推断。', customSize: '自定义大小',
  },
  'zh-Hant': {
    storage: '儲存位置', storageDescription: '可用位置中的確切原生儲存名稱。',
    cpu: 'CPU 核心數', memory: '記憶體（位元組）', disk: '磁碟大小（位元組）', imageKind: '映像選擇',
    publishedImage: '已發佈映像', nativeReference: '原生映像參照', publishedReference: '已發佈映像參照',
    nativeDescription: '為此客體準備的帶標籤或摘要的 Lume 格式映像。',
    privateCarrier: '已準備的私有連線', privateDescription: '僅選擇經過審查並為使用預設密碼的 Lume 原生 SSH 準備好的映像。',
    preparedSsh: '已為 Lume 原生 SSH 準備', guestOs: '已準備的客體系統', user: '已準備的 SSH 使用者',
    userDescription: '在此映像中明確準備的帳戶；絕不會根據客體系統推斷。', customSize: '自訂大小',
  },
  ja: {
    storage: 'ストレージ', storageDescription: '利用可能な場所に含まれる正確なネイティブストレージ名。',
    cpu: 'CPU コア数', memory: 'メモリ（バイト）', disk: 'ディスク容量（バイト）', imageKind: 'イメージの選択',
    publishedImage: '公開イメージ', nativeReference: 'ネイティブイメージの参照', publishedReference: '公開イメージの参照',
    nativeDescription: 'このゲスト用に準備された、タグまたはダイジェスト付きの Lume 形式イメージ。',
    privateCarrier: '準備済みのプライベート接続', privateDescription: 'Lume ネイティブ SSH の既定パスワードを使うよう準備された、確認済みのイメージのみ選択してください。',
    preparedSsh: 'Lume ネイティブ SSH 用に準備済み', guestOs: '準備済みのゲスト OS', user: '準備済みの SSH ユーザー',
    userDescription: 'このイメージで明示的に準備されたアカウントです。ゲスト OS から推測することはありません。', customSize: 'カスタムサイズ',
  },
};

export function lumeConfigurationLabel(id: keyof typeof LUME_CONFIGURATION_LABELS.en): PluginLocalizedStringV2 {
  return { key: `machineLume.configure.${id}`, fallback: LUME_CONFIGURATION_LABELS.en[id] };
}

const CONFIGURATION_TRANSLATION_BUNDLES = Object.freeze(Object.entries(LUME_CONFIGURATION_LABELS).map(([locale, labels]) => ({
  locale, messages: Object.fromEntries(Object.entries(labels).map(([id, value]) => [`machineLume.configure.${id}`, value])),
})) satisfies readonly UiTranslationBundle[]);

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"VM","description":"A local macOS or Linux VM with your chosen image.","ready":"Installed","unavailable":"Runtime unavailable","lume_transport":"Connection unavailable","lume_http":"Connection unavailable","lume_response":"Runtime response unavailable"},
  "de": {"kind":"VM","description":"Eine lokale macOS- oder Linux-VM mit deinem gewählten Image.","ready":"Installiert","unavailable":"Laufzeit nicht verfügbar","lume_transport":"Verbindung nicht verfügbar","lume_http":"Verbindung nicht verfügbar","lume_response":"Laufzeitantwort nicht verfügbar"},
  "ru": {"kind":"ВМ","description":"Локальная ВМ macOS или Linux с выбранным образом.","ready":"Установлено","unavailable":"Среда недоступна","lume_transport":"Соединение недоступно","lume_http":"Соединение недоступно","lume_response":"Ответ среды недоступен"},
  "pl": {"kind":"VM","description":"Lokalna maszyna macOS lub Linux z wybranym obrazem.","ready":"Zainstalowano","unavailable":"Środowisko niedostępne","lume_transport":"Połączenie niedostępne","lume_http":"Połączenie niedostępne","lume_response":"Odpowiedź środowiska niedostępna"},
  "es": {"kind":"VM","description":"Una VM macOS o Linux local con la imagen elegida.","ready":"Instalado","unavailable":"Entorno no disponible","lume_transport":"Conexión no disponible","lume_http":"Conexión no disponible","lume_response":"Respuesta del entorno no disponible"},
  "fr": {"kind":"VM","description":"Une VM macOS ou Linux locale avec l’image choisie.","ready":"Installé","unavailable":"Environnement indisponible","lume_transport":"Connexion indisponible","lume_http":"Connexion indisponible","lume_response":"Réponse de l’environnement indisponible"},
  "it": {"kind":"VM","description":"Una VM macOS o Linux locale con l’immagine scelta.","ready":"Installato","unavailable":"Ambiente non disponibile","lume_transport":"Connessione non disponibile","lume_http":"Connessione non disponibile","lume_response":"Risposta dell’ambiente non disponibile"},
  "pt": {"kind":"VM","description":"Uma VM macOS ou Linux local com a imagem escolhida.","ready":"Instalado","unavailable":"Ambiente indisponível","lume_transport":"Conexão indisponível","lume_http":"Conexão indisponível","lume_response":"Resposta do ambiente indisponível"},
  "ca": {"kind":"VM","description":"Una VM macOS o Linux local amb la imatge triada.","ready":"Instal·lat","unavailable":"Entorn no disponible","lume_transport":"Connexió no disponible","lume_http":"Connexió no disponible","lume_response":"Resposta de l’entorn no disponible"},
  "zh-Hans": {"kind":"虚拟机","description":"使用所选镜像的本地 macOS 或 Linux 虚拟机。","ready":"已安装","unavailable":"运行环境不可用","lume_transport":"连接不可用","lume_http":"连接不可用","lume_response":"运行环境响应不可用"},
  "zh-Hant": {"kind":"虛擬機","description":"使用所選映像的本地 macOS 或 Linux 虛擬機。","ready":"已安裝","unavailable":"執行環境不可用","lume_transport":"連線不可用","lume_http":"連線不可用","lume_response":"執行環境回應不可用"},
  "ja": {"kind":"VM","description":"選択したイメージを使うローカルの macOS または Linux VM。","ready":"インストール済み","unavailable":"ランタイム利用不可","lume_transport":"接続利用不可","lume_http":"接続利用不可","lume_response":"ランタイムの応答を取得できません"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineLume.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}

export const LUME_UI_TRANSLATION_BUNDLES: readonly UiTranslationBundle[] = CONFIGURATION_TRANSLATION_BUNDLES.map(bundle => ({
  ...bundle, messages: { ...bundle.messages, ...Object.fromEntries(Object.entries(MACHINE_PRESENTATION_LABELS[bundle.locale as keyof typeof MACHINE_PRESENTATION_LABELS])
    .map(([id, value]) => ['machineLume.presentation.' + id, value])) },
}));
import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk/manifest';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
