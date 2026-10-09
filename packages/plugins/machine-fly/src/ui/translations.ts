import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

const en = {
  appOwnership: 'App', createApp: 'Create a new app', existingApp: 'Use an existing app', appName: 'App name',
  organization: 'Organization', organizationDescription: 'Use the organization configured for the selected Fly account.',
  region: 'Region code', image: 'Image', imageDescription: 'Optional; defaults to Ubuntu 24.04 when not supplied.',
  cpuKind: 'CPU kind', shared: 'Shared', performance: 'Performance', cpus: 'CPU count', memory: 'Memory (MB)',
  volumeKind: 'Persistent volume', createVolume: 'Create a new volume', attachVolume: 'Attach an existing volume',
  volumeSize: 'Volume size (GB)', volumeId: 'Volume ID',
} as const;

export const FLY_CONFIGURATION_LABELS = {
  en,
  de: {
    appOwnership: 'App', createApp: 'Neue App erstellen', existingApp: 'Vorhandene App verwenden', appName: 'App-Name',
    organization: 'Organisation', organizationDescription: 'Verwende die für das ausgewählte Fly-Konto konfigurierte Organisation.',
    region: 'Regionscode', image: 'Image', imageDescription: 'Optional; ohne Angabe wird Ubuntu 24.04 verwendet.',
    cpuKind: 'CPU-Typ', shared: 'Geteilt', performance: 'Leistung', cpus: 'CPU-Anzahl', memory: 'Arbeitsspeicher (MB)',
    volumeKind: 'Dauerhaftes Volume', createVolume: 'Neues Volume erstellen', attachVolume: 'Vorhandenes Volume verbinden',
    volumeSize: 'Volume-Größe (GB)', volumeId: 'Volume-ID',
  },
  ru: {
    appOwnership: 'Приложение', createApp: 'Создать приложение', existingApp: 'Использовать существующее приложение', appName: 'Имя приложения',
    organization: 'Организация', organizationDescription: 'Используйте организацию, настроенную для выбранного аккаунта Fly.',
    region: 'Код региона', image: 'Образ', imageDescription: 'Необязательно; если не указано, используется Ubuntu 24.04.',
    cpuKind: 'Тип CPU', shared: 'Общий', performance: 'Производительный', cpus: 'Количество CPU', memory: 'Память (МБ)',
    volumeKind: 'Постоянный том', createVolume: 'Создать том', attachVolume: 'Подключить существующий том',
    volumeSize: 'Размер тома (ГБ)', volumeId: 'ID тома',
  },
  pl: {
    appOwnership: 'Aplikacja', createApp: 'Utwórz nową aplikację', existingApp: 'Użyj istniejącej aplikacji', appName: 'Nazwa aplikacji',
    organization: 'Organizacja', organizationDescription: 'Użyj organizacji skonfigurowanej dla wybranego konta Fly.',
    region: 'Kod regionu', image: 'Obraz', imageDescription: 'Opcjonalne; bez podania używany jest Ubuntu 24.04.',
    cpuKind: 'Typ CPU', shared: 'Współdzielony', performance: 'Wydajny', cpus: 'Liczba CPU', memory: 'Pamięć (MB)',
    volumeKind: 'Trwały wolumin', createVolume: 'Utwórz nowy wolumin', attachVolume: 'Podłącz istniejący wolumin',
    volumeSize: 'Rozmiar woluminu (GB)', volumeId: 'ID woluminu',
  },
  es: {
    appOwnership: 'Aplicación', createApp: 'Crear una aplicación', existingApp: 'Usar una aplicación existente', appName: 'Nombre de la aplicación',
    organization: 'Organización', organizationDescription: 'Usa la organización configurada para la cuenta de Fly seleccionada.',
    region: 'Código de región', image: 'Imagen', imageDescription: 'Opcional; si no se indica, se usa Ubuntu 24.04.',
    cpuKind: 'Tipo de CPU', shared: 'Compartida', performance: 'Alto rendimiento', cpus: 'Número de CPU', memory: 'Memoria (MB)',
    volumeKind: 'Volumen persistente', createVolume: 'Crear un volumen', attachVolume: 'Conectar un volumen existente',
    volumeSize: 'Tamaño del volumen (GB)', volumeId: 'ID del volumen',
  },
  fr: {
    appOwnership: 'Application', createApp: 'Créer une application', existingApp: 'Utiliser une application existante', appName: 'Nom de l’application',
    organization: 'Organisation', organizationDescription: 'Utilisez l’organisation configurée pour le compte Fly sélectionné.',
    region: 'Code de région', image: 'Image', imageDescription: 'Facultatif ; Ubuntu 24.04 est utilisé si aucune image n’est indiquée.',
    cpuKind: 'Type de CPU', shared: 'Partagé', performance: 'Haute performance', cpus: 'Nombre de CPU', memory: 'Mémoire (Mo)',
    volumeKind: 'Volume persistant', createVolume: 'Créer un volume', attachVolume: 'Connecter un volume existant',
    volumeSize: 'Taille du volume (Go)', volumeId: 'ID du volume',
  },
  it: {
    appOwnership: 'App', createApp: 'Crea una nuova app', existingApp: 'Usa un’app esistente', appName: 'Nome dell’app',
    organization: 'Organizzazione', organizationDescription: 'Usa l’organizzazione configurata per l’account Fly selezionato.',
    region: 'Codice della regione', image: 'Immagine', imageDescription: 'Facoltativo; se non specificata, viene usata Ubuntu 24.04.',
    cpuKind: 'Tipo di CPU', shared: 'Condivisa', performance: 'Alte prestazioni', cpus: 'Numero di CPU', memory: 'Memoria (MB)',
    volumeKind: 'Volume persistente', createVolume: 'Crea un nuovo volume', attachVolume: 'Collega un volume esistente',
    volumeSize: 'Dimensione del volume (GB)', volumeId: 'ID del volume',
  },
  pt: {
    appOwnership: 'Aplicativo', createApp: 'Criar um aplicativo', existingApp: 'Usar um aplicativo existente', appName: 'Nome do aplicativo',
    organization: 'Organização', organizationDescription: 'Use a organização configurada para a conta Fly selecionada.',
    region: 'Código da região', image: 'Imagem', imageDescription: 'Opcional; se não informada, Ubuntu 24.04 é usado.',
    cpuKind: 'Tipo de CPU', shared: 'Compartilhada', performance: 'Alto desempenho', cpus: 'Número de CPUs', memory: 'Memória (MB)',
    volumeKind: 'Volume persistente', createVolume: 'Criar um volume', attachVolume: 'Conectar um volume existente',
    volumeSize: 'Tamanho do volume (GB)', volumeId: 'ID do volume',
  },
  ca: {
    appOwnership: 'Aplicació', createApp: 'Crea una aplicació', existingApp: 'Utilitza una aplicació existent', appName: 'Nom de l’aplicació',
    organization: 'Organització', organizationDescription: 'Utilitza l’organització configurada per al compte de Fly seleccionat.',
    region: 'Codi de regió', image: 'Imatge', imageDescription: 'Opcional; si no s’indica, s’utilitza Ubuntu 24.04.',
    cpuKind: 'Tipus de CPU', shared: 'Compartida', performance: 'Alt rendiment', cpus: 'Nombre de CPU', memory: 'Memòria (MB)',
    volumeKind: 'Volum persistent', createVolume: 'Crea un volum', attachVolume: 'Connecta un volum existent',
    volumeSize: 'Mida del volum (GB)', volumeId: 'ID del volum',
  },
  'zh-Hans': {
    appOwnership: '应用', createApp: '创建应用', existingApp: '使用现有应用', appName: '应用名称',
    organization: '组织', organizationDescription: '使用所选 Fly 账户配置的组织。',
    region: '区域代码', image: '镜像', imageDescription: '可选；未提供时使用 Ubuntu 24.04。',
    cpuKind: 'CPU 类型', shared: '共享', performance: '高性能', cpus: 'CPU 数量', memory: '内存（MB）',
    volumeKind: '持久卷', createVolume: '创建卷', attachVolume: '挂载现有卷', volumeSize: '卷大小（GB）', volumeId: '卷 ID',
  },
  'zh-Hant': {
    appOwnership: '應用程式', createApp: '建立應用程式', existingApp: '使用現有應用程式', appName: '應用程式名稱',
    organization: '組織', organizationDescription: '使用所選 Fly 帳戶設定的組織。',
    region: '區域代碼', image: '映像', imageDescription: '選填；未提供時使用 Ubuntu 24.04。',
    cpuKind: 'CPU 類型', shared: '共用', performance: '高效能', cpus: 'CPU 數量', memory: '記憶體（MB）',
    volumeKind: '持久磁碟區', createVolume: '建立磁碟區', attachVolume: '掛載現有磁碟區', volumeSize: '磁碟區大小（GB）', volumeId: '磁碟區 ID',
  },
  ja: {
    appOwnership: 'アプリ', createApp: 'アプリを作成', existingApp: '既存のアプリを使用', appName: 'アプリ名',
    organization: '組織', organizationDescription: '選択した Fly アカウントに設定されている組織を使用してください。',
    region: 'リージョンコード', image: 'イメージ', imageDescription: '任意。指定しない場合は Ubuntu 24.04 を使用します。',
    cpuKind: 'CPU の種類', shared: '共有', performance: '高性能', cpus: 'CPU 数', memory: 'メモリ（MB）',
    volumeKind: '永続ボリューム', createVolume: 'ボリュームを作成', attachVolume: '既存のボリュームを接続', volumeSize: 'ボリューム容量（GB）', volumeId: 'ボリューム ID',
  },
} as const satisfies Readonly<Record<string, Readonly<Record<keyof typeof en, string>>>>;

const lifecycleMessages = {
  en: ['Resume may cold-start. Keep important data on its volume.', 'Stopping resets the root filesystem. Its volume is kept.'],
  de: ['Beim Fortsetzen kann ein Kaltstart nötig sein. Bewahre wichtige Daten auf dem Volume auf.', 'Beim Stoppen wird das Root-Dateisystem zurückgesetzt. Das Volume bleibt erhalten.'],
  ru: ['При возобновлении возможен холодный запуск. Храните важные данные на томе.', 'Остановка сбрасывает корневую файловую систему. Том сохраняется.'],
  pl: ['Wznowienie może wymagać zimnego startu. Ważne dane przechowuj na woluminie.', 'Zatrzymanie resetuje główny system plików. Wolumin zostaje zachowany.'],
  es: ['Al reanudar puede ser necesario un arranque en frío. Guarda los datos importantes en el volumen.', 'Al detener se restablece el sistema de archivos raíz. El volumen se conserva.'],
  fr: ['La reprise peut nécessiter un démarrage à froid. Gardez les données importantes sur le volume.', 'L’arrêt réinitialise le système de fichiers racine. Le volume est conservé.'],
  it: ['La ripresa potrebbe richiedere un avvio a freddo. Conserva i dati importanti sul volume.', 'L’arresto reimposta il file system radice. Il volume viene conservato.'],
  pt: ['Ao retomar, pode ser necessária uma inicialização a frio. Guarde dados importantes no volume.', 'A parada redefine o sistema de arquivos raiz. O volume é preservado.'],
  ca: ['En reprendre pot caldre una arrencada en fred. Desa les dades importants al volum.', 'En aturar es restableix el sistema de fitxers arrel. El volum es conserva.'],
  'zh-Hans': ['恢复时可能需要冷启动。请将重要数据保存在卷上。', '停止会重置根文件系统，卷会保留。'],
  'zh-Hant': ['恢復時可能需要冷啟動。請將重要資料儲存在磁碟區上。', '停止會重設根檔案系統，磁碟區會保留。'],
  ja: ['再開時にコールドスタートが必要な場合があります。重要なデータはボリュームに保存してください。', '停止するとルートファイルシステムがリセットされます。ボリュームは保持されます。'],
} as const satisfies Record<keyof typeof FLY_CONFIGURATION_LABELS, readonly [string, string]>;

export const FLY_TRANSLATION_BUNDLES: readonly UiTranslationBundle[] = Object.entries(FLY_CONFIGURATION_LABELS).map(([locale, labels]) => ({
  locale,
  messages: {
    ...Object.fromEntries(Object.entries(labels).map(([id, value]) => [`machineFly.configure.${id}`, value])),
    'machineFly.suspend.continuity': lifecycleMessages[locale as keyof typeof lifecycleMessages][0],
    'machineFly.stop.rootfs': lifecycleMessages[locale as keyof typeof lifecycleMessages][1],
  },
}));
