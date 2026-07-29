type PermissionDetailsTranslation = Readonly<{
    fields: Readonly<{
        pluginId: string;
        capability: string;
        scope: string;
        requester: string;
        authority: string;
        requestedAt: string;
    }>;
    scope: Readonly<{ account: string; project: string; workspace: string }>;
    requester: Readonly<{ user: string; host: string; plugin: string }>;
    authority: Readonly<{ bundled: string; machineInstallation: string }>;
    identifiers: Readonly<{
        session: string;
        request: string;
        machine: string;
        installation: string;
    }>;
    accessibilitySummary: (params: Readonly<{ details: string }>) => string;
}>;

export const pluginPermissionTranslations = {
    en: {
        fields: {
            pluginId: 'Plugin ID',
            capability: 'Capability',
            scope: 'Scope',
            requester: 'Requester',
            authority: 'Authority',
            requestedAt: 'Request time',
        },
        scope: { account: 'Account', project: 'Project', workspace: 'Workspace' },
        requester: { user: 'User', host: 'Host', plugin: 'Plugin' },
        authority: { bundled: 'Bundled', machineInstallation: 'Machine installation' },
        identifiers: {
            session: 'Session',
            request: 'Request',
            machine: 'Machine',
            installation: 'Installation',
        },
        accessibilitySummary: ({ details }) => `Permission request details. ${details}`,
    },
    ru: {
        fields: {
            pluginId: 'Идентификатор плагина',
            capability: 'Возможность',
            scope: 'Область',
            requester: 'Инициатор',
            authority: 'Источник разрешения',
            requestedAt: 'Время запроса',
        },
        scope: { account: 'Учётная запись', project: 'Проект', workspace: 'Рабочая область' },
        requester: { user: 'Пользователь', host: 'Хост', plugin: 'Плагин' },
        authority: { bundled: 'Встроенный', machineInstallation: 'Установка на машине' },
        identifiers: {
            session: 'Сеанс',
            request: 'Запрос',
            machine: 'Машина',
            installation: 'Установка',
        },
        accessibilitySummary: ({ details }) => `Сведения о запросе разрешения. ${details}`,
    },
    pl: {
        fields: {
            pluginId: 'Identyfikator wtyczki',
            capability: 'Uprawnienie',
            scope: 'Zakres',
            requester: 'Wnioskodawca',
            authority: 'Źródło uprawnienia',
            requestedAt: 'Czas żądania',
        },
        scope: { account: 'Konto', project: 'Projekt', workspace: 'Obszar roboczy' },
        requester: { user: 'Użytkownik', host: 'System hosta', plugin: 'Wtyczka' },
        authority: { bundled: 'Wbudowana', machineInstallation: 'Instalacja na maszynie' },
        identifiers: {
            session: 'Sesja',
            request: 'Żądanie',
            machine: 'Maszyna',
            installation: 'Instalacja',
        },
        accessibilitySummary: ({ details }) => `Szczegóły żądania uprawnienia. ${details}`,
    },
    es: {
        fields: {
            pluginId: 'ID del complemento',
            capability: 'Capacidad',
            scope: 'Ámbito',
            requester: 'Solicitante',
            authority: 'Autoridad',
            requestedAt: 'Hora de la solicitud',
        },
        scope: { account: 'Cuenta', project: 'Proyecto', workspace: 'Espacio de trabajo' },
        requester: { user: 'Usuario', host: 'Sistema anfitrión', plugin: 'Complemento' },
        authority: { bundled: 'Incluido', machineInstallation: 'Instalación en una máquina' },
        identifiers: {
            session: 'Sesión',
            request: 'Solicitud',
            machine: 'Máquina',
            installation: 'Instalación',
        },
        accessibilitySummary: ({ details }) => `Detalles de la solicitud de permiso. ${details}`,
    },
    it: {
        fields: {
            pluginId: 'ID dell’estensione',
            capability: 'Funzionalità',
            scope: 'Ambito',
            requester: 'Richiedente',
            authority: 'Autorità',
            requestedAt: 'Ora della richiesta',
        },
        scope: { account: 'Profilo account', project: 'Progetto', workspace: 'Area di lavoro' },
        requester: { user: 'Utente', host: 'Sistema host', plugin: 'Estensione' },
        authority: { bundled: 'Inclusa', machineInstallation: 'Installazione sulla macchina' },
        identifiers: {
            session: 'Sessione',
            request: 'Richiesta',
            machine: 'Macchina',
            installation: 'Installazione',
        },
        accessibilitySummary: ({ details }) => `Dettagli della richiesta di autorizzazione. ${details}`,
    },
    pt: {
        fields: {
            pluginId: 'ID da extensão',
            capability: 'Capacidade',
            scope: 'Âmbito',
            requester: 'Solicitante',
            authority: 'Autoridade',
            requestedAt: 'Hora do pedido',
        },
        scope: { account: 'Conta', project: 'Projeto', workspace: 'Espaço de trabalho' },
        requester: { user: 'Utilizador', host: 'Anfitrião', plugin: 'Extensão' },
        authority: { bundled: 'Incluída', machineInstallation: 'Instalação na máquina' },
        identifiers: {
            session: 'Sessão',
            request: 'Pedido',
            machine: 'Máquina',
            installation: 'Instalação',
        },
        accessibilitySummary: ({ details }) => `Detalhes do pedido de permissão. ${details}`,
    },
    ca: {
        fields: {
            pluginId: 'ID del complement',
            capability: 'Capacitat',
            scope: 'Àmbit',
            requester: 'Sol·licitant',
            authority: 'Autoritat',
            requestedAt: 'Hora de la sol·licitud',
        },
        scope: { account: 'Compte', project: 'Projecte', workspace: 'Espai de treball' },
        requester: { user: 'Usuari', host: 'Amfitrió', plugin: 'Complement' },
        authority: { bundled: 'Inclòs', machineInstallation: 'Instal·lació a la màquina' },
        identifiers: {
            session: 'Sessió',
            request: 'Sol·licitud',
            machine: 'Màquina',
            installation: 'Instal·lació',
        },
        accessibilitySummary: ({ details }) => `Detalls de la sol·licitud de permís. ${details}`,
    },
    'zh-Hans': {
        fields: {
            pluginId: '插件 ID',
            capability: '能力',
            scope: '范围',
            requester: '请求方',
            authority: '授权来源',
            requestedAt: '请求时间',
        },
        scope: { account: '账户', project: '项目', workspace: '工作区' },
        requester: { user: '用户', host: '主机', plugin: '插件' },
        authority: { bundled: '内置', machineInstallation: '机器安装' },
        identifiers: {
            session: '会话',
            request: '请求',
            machine: '机器',
            installation: '安装',
        },
        accessibilitySummary: ({ details }) => `权限请求详情。${details}`,
    },
    'zh-Hant': {
        fields: {
            pluginId: '外掛 ID',
            capability: '功能',
            scope: '範圍',
            requester: '請求者',
            authority: '授權來源',
            requestedAt: '請求時間',
        },
        scope: { account: '帳戶', project: '專案', workspace: '工作區' },
        requester: { user: '使用者', host: '主機', plugin: '外掛' },
        authority: { bundled: '內建', machineInstallation: '機器安裝' },
        identifiers: {
            session: '工作階段',
            request: '請求',
            machine: '機器',
            installation: '安裝',
        },
        accessibilitySummary: ({ details }) => `權限請求詳細資料。${details}`,
    },
    ja: {
        fields: {
            pluginId: 'プラグイン ID',
            capability: '機能',
            scope: 'スコープ',
            requester: '要求元',
            authority: '権限元',
            requestedAt: '要求日時',
        },
        scope: { account: 'アカウント', project: 'プロジェクト', workspace: 'ワークスペース' },
        requester: { user: 'ユーザー', host: 'ホスト', plugin: 'プラグイン' },
        authority: { bundled: '同梱', machineInstallation: 'マシンへのインストール' },
        identifiers: {
            session: 'セッション',
            request: '要求',
            machine: 'マシン',
            installation: 'インストール',
        },
        accessibilitySummary: ({ details }) => `権限要求の詳細。${details}`,
    },
} as const satisfies Readonly<Record<string, PermissionDetailsTranslation>>;
