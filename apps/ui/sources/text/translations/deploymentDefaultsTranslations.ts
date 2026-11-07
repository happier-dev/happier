import type { SupportedLanguage } from '../_all';

type Copy = Readonly<{ accountDescription: string; projectDescription: string; useAccount: string; useBuiltin: string;
    retention: string; clearToInherit: string; projectTitle: string; alertChannels: string; accountLink: string }>;
export const deploymentDefaultsTranslations = {
    en: {
        accountDescription: 'Defaults for new environments in your Account-owned projects. Team projects use their shared project defaults.',
        projectDescription: 'Used when you create an environment. Existing environments keep their own settings.',
        useAccount: 'Use Account default', useBuiltin: 'Use Happier’s default', retention: 'Releases kept for rollback',
        clearToInherit: 'Clear to use the inherited default', projectTitle: 'Deployment settings', alertChannels: 'Notification channels', accountLink: 'Your Account deployment defaults',
    },
    ca: {
        accountDescription: 'Valors per als entorns nous dels projectes del teu compte. Els projectes d’equip fan servir els valors compartits del projecte.',
        projectDescription: 'S’apliquen en crear un entorn. Els entorns existents conserven la seva configuració.',
        useAccount: 'Fes servir el valor del compte', useBuiltin: 'Fes servir el valor de Happier', retention: 'Versions conservades per desfer',
        clearToInherit: 'Buida-ho per heretar el valor', projectTitle: 'Configuració dels desplegaments', alertChannels: 'Canals de notificacions', accountLink: 'Valors de desplegament del teu compte',
    },
    de: {
        accountDescription: 'Vorgaben für neue Umgebungen deiner Kontoprojekte. Teamprojekte verwenden ihre gemeinsamen Projektvorgaben.',
        projectDescription: 'Gilt beim Erstellen einer Umgebung. Bestehende Umgebungen behalten ihre Einstellungen.',
        useAccount: 'Kontovorgabe verwenden', useBuiltin: 'Happier-Vorgabe verwenden', retention: 'Für Rollback aufbewahrte Versionen',
        clearToInherit: 'Leeren, um die Vorgabe zu übernehmen', projectTitle: 'Bereitstellungseinstellungen', alertChannels: 'Benachrichtigungskanäle', accountLink: 'Bereitstellungsvorgaben deines Kontos',
    },
    es: {
        accountDescription: 'Valores para entornos nuevos en los proyectos de tu cuenta. Los proyectos de equipo usan los valores compartidos del proyecto.',
        projectDescription: 'Se aplican al crear un entorno. Los entornos existentes conservan su configuración.',
        useAccount: 'Usar el valor de la cuenta', useBuiltin: 'Usar el valor de Happier', retention: 'Versiones conservadas para revertir',
        clearToInherit: 'Borra para heredar el valor', projectTitle: 'Configuración de despliegues', alertChannels: 'Canales de notificaciones', accountLink: 'Valores de despliegue de tu cuenta',
    },
    fr: {
        accountDescription: 'Valeurs pour les nouveaux environnements des projets de ton compte. Les projets d’équipe utilisent leurs valeurs partagées.',
        projectDescription: 'Appliquées à la création d’un environnement. Les environnements existants gardent leurs réglages.',
        useAccount: 'Utiliser la valeur du compte', useBuiltin: 'Utiliser la valeur de Happier', retention: 'Versions gardées pour revenir en arrière',
        clearToInherit: 'Effacer pour hériter de la valeur', projectTitle: 'Réglages des déploiements', alertChannels: 'Canaux de notification', accountLink: 'Valeurs de déploiement de ton compte',
    },
    it: {
        accountDescription: 'Valori per i nuovi ambienti nei progetti del tuo account. I progetti del team usano i valori condivisi del progetto.',
        projectDescription: 'Usati quando crei un ambiente. Gli ambienti esistenti mantengono le proprie impostazioni.',
        useAccount: 'Usa il valore dell’account', useBuiltin: 'Usa il valore di Happier', retention: 'Versioni conservate per il ripristino',
        clearToInherit: 'Svuota per ereditare il valore', projectTitle: 'Impostazioni dei deployment', alertChannels: 'Canali di notifica', accountLink: 'Valori di deployment del tuo account',
    },
    ja: {
        accountDescription: 'アカウント所有プロジェクトの新しい環境に適用する既定値です。チームのプロジェクトでは共有のプロジェクト既定値を使います。',
        projectDescription: '環境の作成時に適用します。既存の環境は現在の設定を維持します。',
        useAccount: 'アカウントの既定値を使う', useBuiltin: 'Happierの既定値を使う', retention: 'ロールバック用に保持するリリース数',
        clearToInherit: '空にすると既定値を継承します', projectTitle: 'デプロイ設定', alertChannels: '通知チャンネル', accountLink: 'アカウントのデプロイ既定値',
    },
    pl: {
        accountDescription: 'Domyślne ustawienia nowych środowisk w projektach Twojego konta. Projekty zespołu używają wspólnych ustawień projektu.',
        projectDescription: 'Stosowane przy tworzeniu środowiska. Istniejące środowiska zachowują swoje ustawienia.',
        useAccount: 'Użyj ustawienia konta', useBuiltin: 'Użyj ustawienia Happier', retention: 'Wersje zachowane do wycofania',
        clearToInherit: 'Wyczyść, aby odziedziczyć ustawienie', projectTitle: 'Ustawienia wdrożeń', alertChannels: 'Kanały powiadomień', accountLink: 'Domyślne ustawienia wdrożeń konta',
    },
    pt: {
        accountDescription: 'Padrões para novos ambientes nos projetos da sua conta. Projetos de equipe usam os padrões compartilhados do projeto.',
        projectDescription: 'Usados ao criar um ambiente. Os ambientes existentes mantêm suas configurações.',
        useAccount: 'Usar padrão da conta', useBuiltin: 'Usar padrão do Happier', retention: 'Versões mantidas para reverter',
        clearToInherit: 'Limpe para herdar o padrão', projectTitle: 'Configurações de implantação', alertChannels: 'Canais de notificação', accountLink: 'Padrões de implantação da sua conta',
    },
    ru: {
        accountDescription: 'Настройки новых окружений в проектах вашего аккаунта. Командные проекты используют общие настройки проекта.',
        projectDescription: 'Применяются при создании окружения. Существующие окружения сохраняют свои настройки.',
        useAccount: 'Использовать настройку аккаунта', useBuiltin: 'Использовать настройку Happier', retention: 'Версии для отката',
        clearToInherit: 'Очистите, чтобы наследовать настройку', projectTitle: 'Настройки развёртывания', alertChannels: 'Каналы уведомлений', accountLink: 'Настройки развёртывания вашего аккаунта',
    },
    'zh-Hans': {
        accountDescription: '用于你的账号所拥有项目中的新环境。团队项目使用共享的项目默认设置。',
        projectDescription: '创建环境时使用。现有环境保留各自的设置。',
        useAccount: '使用账号默认值', useBuiltin: '使用 Happier 默认值', retention: '为回滚保留的版本数',
        clearToInherit: '清空以继承默认值', projectTitle: '部署设置', alertChannels: '通知渠道', accountLink: '你的账号部署默认设置',
    },
    'zh-Hant': {
        accountDescription: '用於你的帳號所擁有專案中的新環境。團隊專案使用共用的專案預設設定。',
        projectDescription: '建立環境時使用。現有環境保留各自的設定。',
        useAccount: '使用帳號預設值', useBuiltin: '使用 Happier 預設值', retention: '為復原保留的版本數',
        clearToInherit: '清空以繼承預設值', projectTitle: '部署設定', alertChannels: '通知管道', accountLink: '你的帳號部署預設設定',
    },
} satisfies Record<SupportedLanguage, Copy>;
